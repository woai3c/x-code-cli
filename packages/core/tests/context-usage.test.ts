import { describe, expect, it } from 'vitest'

import { jsonSchema, tool } from 'ai'

import { z } from 'zod'

import {
  buildContextBreakdownInput,
  calibrateContextBreakdown,
  estimateContextBreakdown,
} from '../src/agent/context-usage.js'
import { estimateTextTokenCount } from '../src/agent/context-window.js'
import { createLoopState } from '../src/agent/loop-state.js'
import {
  formatDeferredCapabilities,
  formatMcpCapabilities,
  formatSkillCapabilities,
} from '../src/agent/system-prompt.js'

function makeTool(description: string, schema: z.ZodType = z.object({ arg: z.string() })) {
  return {
    type: 'function' as const,
    description,
    inputSchema: schema,
  }
}

describe('estimateTextTokenCount', () => {
  it('uses the bytes-per-token ratio (3.0)', () => {
    expect(estimateTextTokenCount('x'.repeat(300))).toBe(100)
    expect(estimateTextTokenCount('')).toBe(0)
  })
})

describe('estimateContextBreakdown', () => {
  it('splits the system prompt into base / rules / skills / mcp sub-blocks', () => {
    const base = 'You are X-Code CLI.\n\n## Working Rules\n- Read before editing.'
    const knowledge = '## Project Knowledge\n\n### Project AGENTS.md (.)\nSome rules text.'
    const skills = formatSkillCapabilities([{ name: 'frontend-design', description: 'Design UIs' }])
    const mcp = formatMcpCapabilities([
      { callableName: 'fs__read_file', serverName: 'filesystem', description: 'Read a file' },
    ])
    // Mirror buildSystemPrompt's concatenation: blocks substituted into the
    // base, knowledge appended at the end.
    const systemPrompt = `${base}${mcp}${skills}\n\n${knowledge}`

    const breakdown = estimateContextBreakdown({
      systemPrompt,
      knowledgeContext: knowledge,
      skillBlock: skills,
      mcpDeferredBlock: mcp,
      messages: [],
      tools: {},
    })

    const byKey = new Map(breakdown.categories.map((c) => [c.key, c.estimatedTokens]))
    // Subtraction isolates the base; per-block ceils can drift by ±1 each.
    expect(byKey.get('system')).toBeGreaterThanOrEqual(estimateTextTokenCount(base) - 3)
    expect(byKey.get('system')).toBeLessThanOrEqual(estimateTextTokenCount(base) + 3)
    expect(byKey.get('rules')).toBe(estimateTextTokenCount(knowledge))
    expect(byKey.get('skills')).toBe(estimateTextTokenCount(skills))
    expect(byKey.get('mcp')).toBe(estimateTextTokenCount(mcp))
    expect(breakdown.estimatedTotal).toBe(estimateTextTokenCount(systemPrompt))
  })

  it('attributes the task tool to subagents and MCP-backed tools to mcp', () => {
    const task = makeTool('Launch an isolated sub-agent.\n\nAvailable sub-agents:\n  - explore: read-only exploration')
    const mcpTool = makeTool('Filesystem read', z.object({ path: z.string() }))
    const coreTool = makeTool('Read a file', z.object({ filePath: z.string() }))

    const breakdown = estimateContextBreakdown({
      systemPrompt: 'base prompt',
      messages: [],
      tools: { task, readFile: coreTool, filesystem__read_file: mcpTool },
      mcpToolNames: new Set(['filesystem__read_file']),
    })

    const byKey = new Map(breakdown.categories.map((c) => [c.key, c.estimatedTokens]))
    expect(byKey.get('subagents') ?? 0).toBeGreaterThan(0)
    expect(byKey.get('mcp') ?? 0).toBeGreaterThan(0)
    expect(byKey.get('tools') ?? 0).toBeGreaterThan(0)
  })

  it('counts MCP tools wrapped in ai jsonSchema() (not zod)', () => {
    // bridgeMcpTool produces exactly this shape: raw JSON Schema wrapped in
    // ai's jsonSchema(). zodToJsonSchema would throw on it — the estimator
    // must read the wrapped schema via the getter instead.
    const mcpTool = tool({
      description: 'Filesystem read',
      inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } } }),
    })

    const breakdown = estimateContextBreakdown({
      systemPrompt: 'base prompt',
      messages: [],
      tools: { filesystem__read_file: mcpTool },
      mcpToolNames: new Set(['filesystem__read_file']),
    })

    const byKey = new Map(breakdown.categories.map((c) => [c.key, c.estimatedTokens]))
    const mcpTokens = byKey.get('mcp') ?? 0
    expect(mcpTokens).toBeGreaterThan(0)
    // The raw JSON Schema payload is what would actually be serialized.
    expect(mcpTokens).toBe(
      estimateTextTokenCount(
        JSON.stringify({
          description: 'Filesystem read',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        }),
      ),
    )
  })

  it('separates the compaction summary message from the conversation', () => {
    const messages = [
      { role: 'user' as const, content: '[Previous conversation summary]\n## Goal\nBuild the thing.' },
      { role: 'assistant' as const, content: 'I will read the code first.' },
      { role: 'user' as const, content: 'OK, go ahead.' },
    ]
    const breakdown = estimateContextBreakdown({
      systemPrompt: 'base',
      messages,
      tools: {},
    })

    const byKey = new Map(breakdown.categories.map((c) => [c.key, c.estimatedTokens]))
    expect(byKey.get('summary') ?? 0).toBeGreaterThan(0)
    expect(byKey.get('conversation') ?? 0).toBeGreaterThan(0)
    // Summary is the first message only; the rest land in conversation.
    expect(byKey.get('summary')).toBe(estimateTextTokenCount(messages[0]!.content as string))
    expect(byKey.get('conversation')).toBe(
      estimateTextTokenCount(messages[1]!.content as string) + estimateTextTokenCount(messages[2]!.content as string),
    )
  })

  it('hides zero-token categories and reports an empty total', () => {
    const breakdown = estimateContextBreakdown({
      systemPrompt: '',
      messages: [],
      tools: {},
    })
    expect(breakdown.categories).toEqual([])
    expect(breakdown.estimatedTotal).toBe(0)
  })
})

describe('calibrateContextBreakdown', () => {
  it('scales estimates so the parts sum exactly to the real total', () => {
    const breakdown = estimateContextBreakdown({
      systemPrompt: 'system prompt text',
      knowledgeContext: 'rules text',
      messages: [{ role: 'user' as const, content: 'conversation text' }],
      tools: {},
    })
    const realTotal = breakdown.estimatedTotal + 100

    const calibrated = calibrateContextBreakdown(breakdown, realTotal)
    expect(calibrated.reduce((sum, c) => sum + c.tokens, 0)).toBe(realTotal)
    for (const c of calibrated) expect(c.tokens).toBeGreaterThan(0)
  })

  it('absorbs rounding drift on the largest category', () => {
    const breakdown = estimateContextBreakdown({
      systemPrompt: 'a'.repeat(9000),
      messages: [{ role: 'user' as const, content: 'b'.repeat(300) }],
      tools: {},
    })
    // 3000 (system) + 100 (conversation) = 3100 estimated. A real total of
    // 3101 scales system to 3000.97 → rounds to 3001, conversation to 100 —
    // the sum matches with zero drift, so nothing needs adjusting.
    const calibrated = calibrateContextBreakdown(breakdown, 3101)
    expect(calibrated.reduce((sum, c) => sum + c.tokens, 0)).toBe(3101)
    expect(calibrated.find((c) => c.key === 'system')!.tokens).toBe(3001)
  })

  it('returns empty when there is nothing to calibrate', () => {
    expect(calibrateContextBreakdown({ categories: [], estimatedTotal: 0 }, 100)).toEqual([])
  })
})

describe('buildContextBreakdownInput', () => {
  it('returns null before the system prompt has been built', () => {
    const state = createLoopState()
    expect(buildContextBreakdownInput({ modelId: 'deepseek:deepseek-v4-flash' } as any, state)).toBeNull()
  })

  it('derives the deferred-tools block from the catalog', () => {
    const state = createLoopState()
    state.systemPromptCache = 'prompt'
    // In production the catalog and the prompt cache are built in the same
    // loop iteration, so the estimator reads the catalog already on state.
    state.deferredCatalog = [
      {
        name: 'webSearch',
        description: 'Search the web',
        searchText: 'web search',
        source: 'builtin',
        def: makeTool('Search the web'),
      },
    ]
    const options = { modelId: 'deepseek:deepseek-v4-flash' } as any
    const input = buildContextBreakdownInput(options, state)!
    expect(input.systemPrompt).toBe('prompt')
    expect(input.mcpDeferredBlock).toBe(formatDeferredCapabilities([{ name: 'webSearch', source: 'builtin' }]))
    expect(input.messages).toBe(state.messages)
  })

  it('prefers the blocks snapshotted at prompt-build time over recomputation', () => {
    const state = createLoopState()
    state.systemPromptCache = 'prompt with embedded blocks'
    state.systemPromptBlocks = { knowledge: 'knowledge', skill: 'skills block', mcpDeferred: 'mcp block' }
    const options = { modelId: 'deepseek:deepseek-v4-flash' } as any
    const input = buildContextBreakdownInput(options, state)!
    expect(input.knowledgeContext).toBe('knowledge')
    expect(input.skillBlock).toBe('skills block')
    expect(input.mcpDeferredBlock).toBe('mcp block')
  })

  it('does not mutate the live deferredCatalog reference', () => {
    const state = createLoopState()
    state.systemPromptCache = 'prompt'
    const catalog = [
      {
        name: 'webSearch',
        description: 'Search the web',
        searchText: 'web search',
        source: 'builtin' as const,
        def: makeTool('Search the web'),
      },
    ]
    state.deferredCatalog = catalog
    buildContextBreakdownInput({ modelId: 'deepseek:deepseek-v4-flash' } as any, state)
    expect(state.deferredCatalog).toBe(catalog)
  })

  it('rebuilds the effective tool map including activated tools', () => {
    const state = createLoopState()
    state.systemPromptCache = 'prompt'
    const def = makeTool('Search the web')
    state.deferredCatalog = [
      {
        name: 'webSearch',
        description: 'Search the web',
        searchText: 'web search',
        source: 'builtin',
        def,
      },
    ]
    state.activatedTools = new Set(['webSearch'])
    // standard profile skips the catalog-weight gate, so the internal rebuild
    // keeps deferral active (webSearch stripped from base, toolSearch added)
    // and the activated tool splices back in from the ORIGINAL catalog.
    const options = { modelId: 'anthropic:claude-sonnet-5', toolProfile: 'standard' } as any
    const input = buildContextBreakdownInput(options, state)!
    expect(input.tools.webSearch).toBe(def)
    expect('toolSearch' in input.tools).toBe(true)
    expect(input.mcpToolNames).toBeInstanceOf(Set)
  })
})
