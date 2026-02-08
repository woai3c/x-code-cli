// Tests for tool registry
// Note: Uses dynamic import to handle module resolution issues in test environment

import { describe, it, expect, vi } from 'vitest'

// Mock cheerio + turndown to avoid module resolution issues in test env
vi.mock('cheerio', () => ({
  load: vi.fn(() => {
    const $ = () => ({ remove: vi.fn(), first: vi.fn(() => ({ length: 0, html: () => '' })), html: () => '' })
    $.load = $
    return $
  }),
}))

vi.mock('turndown', () => ({
  default: class { turndown() { return '' } },
}))

import { toolRegistry, truncateToolResult, MAX_TOOL_RESULT_CHARS } from '../src/tools/index.js'

describe('toolRegistry', () => {
  it('contains all 13 tools', () => {
    const toolNames = Object.keys(toolRegistry)
    expect(toolNames).toHaveLength(13)
    expect(toolNames).toContain('readFile')
    expect(toolNames).toContain('writeFile')
    expect(toolNames).toContain('edit')
    expect(toolNames).toContain('shell')
    expect(toolNames).toContain('glob')
    expect(toolNames).toContain('grep')
    expect(toolNames).toContain('listDir')
    expect(toolNames).toContain('webSearch')
    expect(toolNames).toContain('webFetch')
    expect(toolNames).toContain('askUser')
    expect(toolNames).toContain('saveKnowledge')
    expect(toolNames).toContain('enterPlanMode')
    expect(toolNames).toContain('exitPlanMode')
  })

  it('each tool has a description', () => {
    for (const [name, tool] of Object.entries(toolRegistry)) {
      expect(tool.description, `Tool "${name}" missing description`).toBeTruthy()
    }
  })

  it('each tool has an inputSchema (Zod)', () => {
    for (const [name, tool] of Object.entries(toolRegistry)) {
      expect(tool.inputSchema, `Tool "${name}" missing inputSchema`).toBeDefined()
    }
  })

  it('read-only tools have execute function', () => {
    const readOnlyTools = ['readFile', 'glob', 'grep', 'listDir', 'webSearch', 'webFetch', 'saveKnowledge']
    for (const name of readOnlyTools) {
      const tool = toolRegistry[name as keyof typeof toolRegistry]
      expect(tool.execute, `Tool "${name}" should have execute`).toBeDefined()
    }
  })

  it('write tools do NOT have execute function', () => {
    const writeTools = ['writeFile', 'edit', 'shell']
    for (const name of writeTools) {
      const tool = toolRegistry[name as keyof typeof toolRegistry]
      expect(tool.execute, `Tool "${name}" should NOT have execute`).toBeUndefined()
    }
  })
})

describe('truncateToolResult', () => {
  it('does not truncate short results', () => {
    const short = 'hello world'
    expect(truncateToolResult(short)).toBe(short)
  })

  it('does not truncate results at exactly the limit', () => {
    const exact = 'x'.repeat(MAX_TOOL_RESULT_CHARS)
    expect(truncateToolResult(exact)).toBe(exact)
  })

  it('truncates long results keeping head and tail', () => {
    const long = 'x'.repeat(MAX_TOOL_RESULT_CHARS + 1000)
    const result = truncateToolResult(long)
    expect(result.length).toBeLessThan(long.length)
    expect(result).toContain('truncated')
  })
})
