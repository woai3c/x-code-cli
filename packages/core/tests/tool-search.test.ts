// Tests for the deferred-tool / toolSearch machinery: keyword scoring,
// the select: exact-load path, catalog construction, and per-turn composition.
import { describe, expect, it, vi } from 'vitest'

import { createLoopState } from '../src/agent/loop-state.js'
import { buildTools } from '../src/agent/loop.js'
import {
  DEFERRED_BUILTIN_TOOLS,
  type DeferredToolEntry,
  buildDeferredCatalog,
  composeTurnTools,
  isWeakModel,
  resolveEffectiveToolProfile,
} from '../src/agent/tool-search/catalog.js'
import { runToolSearch } from '../src/agent/tool-search/resolve.js'
import { searchDeferredTools } from '../src/agent/tool-search/search.js'

// catalog.ts imports toolRegistry, which transitively pulls webFetch →
// cheerio + turndown. Mock them so the import doesn't fail in the test env.
vi.mock('cheerio', () => ({
  load: vi.fn(() => {
    const $ = () => ({ remove: vi.fn(), first: vi.fn(() => ({ length: 0, html: () => '' })), html: () => '' })
    $.load = $
    return $
  }),
}))
vi.mock('turndown', () => ({
  default: class {
    turndown() {
      return ''
    }
  },
}))

/** Build a synthetic catalog entry — searchText is what the scorer matches on. */
function entry(
  name: string,
  description: string,
  source: 'builtin' | 'mcp' = 'mcp',
  serverName?: string,
): DeferredToolEntry {
  const searchText = `${name} ${name.replace(/_/g, ' ')} ${serverName ?? ''} ${description}`.toLowerCase()
  return { name, description, searchText, source, serverName, def: { description } }
}

const CATALOG: DeferredToolEntry[] = [
  entry('mcp__github__create_issue', 'Create a new issue in a repository', 'mcp', 'github'),
  entry('mcp__github__list_issues', 'List issues in a repository', 'mcp', 'github'),
  entry('mcp__slack__send_message', 'Post a message to a Slack channel', 'mcp', 'slack'),
  entry('webSearch', 'Search the web for current information', 'builtin'),
]

describe('searchDeferredTools', () => {
  it('returns an exact name match directly (model used a bare name)', () => {
    expect(searchDeferredTools('mcp__slack__send_message', CATALOG, 5)).toEqual(['mcp__slack__send_message'])
  })

  it('matches by mcp__server prefix', () => {
    const r = searchDeferredTools('mcp__github', CATALOG, 5)
    expect(r).toContain('mcp__github__create_issue')
    expect(r).toContain('mcp__github__list_issues')
    expect(r).not.toContain('mcp__slack__send_message')
  })

  it('scores name-part matches above description-only matches', () => {
    // "issue" is in two github tool names; "create" disambiguates to create_issue.
    const r = searchDeferredTools('create issue', CATALOG, 5)
    expect(r[0]).toBe('mcp__github__create_issue')
  })

  it('matches a capability phrase against the description', () => {
    expect(searchDeferredTools('search the web', CATALOG, 5)).toContain('webSearch')
  })

  it('honors +required terms (must appear in all candidates)', () => {
    const r = searchDeferredTools('+slack message', CATALOG, 5)
    expect(r).toEqual(['mcp__slack__send_message'])
  })

  it('returns nothing for a query that matches no tool', () => {
    expect(searchDeferredTools('quantum teleporter', CATALOG, 5)).toEqual([])
  })

  it('respects maxResults', () => {
    expect(searchDeferredTools('issue', CATALOG, 1)).toHaveLength(1)
  })
})

describe('runToolSearch', () => {
  it('select:<name> loads exact tools and reports them activated', () => {
    const r = runToolSearch('select:mcp__github__create_issue,webSearch', 5, CATALOG)
    expect(r.activated).toEqual(['mcp__github__create_issue', 'webSearch'])
    expect(r.text).toContain('Loaded 2 tool(s)')
  })

  it('select: is case-insensitive on the tool name and notes misses', () => {
    const r = runToolSearch('select:WEBSEARCH,nope_tool', 5, CATALOG)
    expect(r.activated).toEqual(['webSearch'])
    expect(r.text).toContain('not found: nope_tool')
  })

  it('select: with no real names activates nothing', () => {
    const r = runToolSearch('select:does_not_exist', 5, CATALOG)
    expect(r.activated).toEqual([])
    expect(r.text).toContain('No deferred tools matched')
  })

  it('keyword query activates the matched tools', () => {
    const r = runToolSearch('create issue', 5, CATALOG)
    expect(r.activated).toContain('mcp__github__create_issue')
  })

  it('treats bare comma-joined exact names as an implicit select', () => {
    // The model listing names ("webSearch,mcp__slack__send_message") instead of
    // using select: must NOT fall into fuzzy scoring (which would miss).
    const r = runToolSearch('webSearch,mcp__slack__send_message', 5, CATALOG)
    expect(r.activated).toEqual(['webSearch', 'mcp__slack__send_message'])
    expect(r.text).toContain('Loaded 2 tool(s)')
  })

  it('treats bare space-separated exact names as an implicit select', () => {
    const r = runToolSearch('webSearch mcp__github__create_issue', 5, CATALOG)
    expect(r.activated).toEqual(['webSearch', 'mcp__github__create_issue'])
  })

  it('falls through to keyword search when not every bare token is an exact name', () => {
    // "create" alone is not a tool name → no implicit select; keyword scoring
    // still resolves it to the create_issue tool.
    const r = runToolSearch('create issue', 5, CATALOG)
    expect(r.activated).toContain('mcp__github__create_issue')
    // A mix of one exact name + one unknown token also stays on the keyword path.
    const mixed = runToolSearch('webSearch bogusname', 5, CATALOG)
    expect(mixed.activated).not.toContain('bogusname')
  })

  it('reports no matches without activating anything', () => {
    const r = runToolSearch('nonexistent capability', 5, CATALOG)
    expect(r.activated).toEqual([])
    expect(r.text).toContain('No matching deferred tools')
  })
})

describe('composeTurnTools', () => {
  const base = { readFile: { description: 'read' }, toolSearch: { description: 'search' } }

  it('returns the base reference unchanged when nothing is activated', () => {
    expect(composeTurnTools(base, CATALOG, new Set())).toBe(base)
  })

  it('returns base unchanged when there is no catalog', () => {
    expect(composeTurnTools(base, undefined, new Set(['webSearch']))).toBe(base)
  })

  it('splices activated tool definitions into a fresh map', () => {
    const result = composeTurnTools(base, CATALOG, new Set(['webSearch', 'mcp__slack__send_message']))
    expect(result).not.toBe(base)
    expect(Object.keys(result)).toContain('readFile')
    expect(Object.keys(result)).toContain('webSearch')
    expect(Object.keys(result)).toContain('mcp__slack__send_message')
  })

  it('ignores activated names not present in the catalog', () => {
    const result = composeTurnTools(base, CATALOG, new Set(['ghost_tool']))
    expect(Object.keys(result)).not.toContain('ghost_tool')
  })

  it('exposes only the mode transition tool valid for the current turn', () => {
    const modeBase = { readFile: { id: 'read' }, enterPlanMode: { id: 'enter' }, exitPlanMode: { id: 'exit' } }

    expect(Object.keys(composeTurnTools(modeBase, undefined, new Set(), 'default'))).toEqual([
      'readFile',
      'enterPlanMode',
    ])
    expect(Object.keys(composeTurnTools(modeBase, undefined, new Set(), 'plan'))).toEqual(['readFile', 'exitPlanMode'])
  })
})

describe('buildDeferredCatalog', () => {
  // Use a tiny context window (100) to ensure catalog EXCEEDS the 10% threshold
  // (even the built-in entries add up to more than 10 tokens).
  const LARGE_CTX = 100

  const mcpTools = [
    {
      callableName: 'mcp__db__query_rows',
      rawName: 'query_rows',
      serverName: 'db',
      description: 'Run a SQL query',
      inputSchema: { type: 'object', properties: { sql: { type: 'string' }, limit: { type: 'number' } } },
    },
  ]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const options = { mcpRegistry: { list: () => mcpTools } } as any

  it('defers the non-core built-ins plus the MCP resource tools', () => {
    const catalog = buildDeferredCatalog(options, LARGE_CTX)
    const names = catalog.map((e) => e.name)
    for (const name of DEFERRED_BUILTIN_TOOLS) expect(names).toContain(name)
    expect(names).toContain('listMcpResources')
    expect(names).toContain('readMcpResource')
  })

  it('includes MCP tools and folds their schema property names into searchText', () => {
    const catalog = buildDeferredCatalog(options, LARGE_CTX)
    const dbTool = catalog.find((e) => e.name === 'mcp__db__query_rows')
    expect(dbTool).toBeDefined()
    expect(dbTool!.source).toBe('mcp')
    expect(dbTool!.serverName).toBe('db')
    // schema property names ("sql") are searchable even though the description
    // doesn't mention them.
    expect(dbTool!.searchText).toContain('sql')
    expect(searchDeferredTools('sql', catalog, 5)).toContain('mcp__db__query_rows')
  })

  it('omits the MCP resource tools when no registry is configured', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catalog = buildDeferredCatalog({} as any, LARGE_CTX)
    const names = catalog.map((e) => e.name)
    expect(names).not.toContain('listMcpResources')
    expect(names).toContain('webSearch')
  })

  it('returns empty catalog for weak models (threshold gate)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const weakOpts = { ...options, modelId: 'anthropic:claude-haiku-4-5' } as any
    const catalog = buildDeferredCatalog(weakOpts, LARGE_CTX)
    expect(catalog).toEqual([])
  })

  it('returns empty catalog when schema weight is below threshold', () => {
    // A context window of 10M means 10% = 1M tokens threshold — our tiny
    // catalog will never reach that.
    const catalog = buildDeferredCatalog(options, 10_000_000)
    expect(catalog).toEqual([])
  })

  it('skips MCP tools with annotations.alwaysLoad', () => {
    const toolsWithAlwaysLoad = [
      ...mcpTools,
      {
        callableName: 'mcp__db__always_tool',
        rawName: 'always_tool',
        serverName: 'db',
        description: 'Always loaded',
        inputSchema: { type: 'object', properties: {} },
        annotations: { alwaysLoad: true },
      },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = { mcpRegistry: { list: () => toolsWithAlwaysLoad } } as any
    const catalog = buildDeferredCatalog(opts, LARGE_CTX)
    const names = catalog.map((e) => e.name)
    expect(names).not.toContain('mcp__db__always_tool')
    expect(names).toContain('mcp__db__query_rows')
  })

  it('keeps alwaysLoad MCP tools in the direct map while deferral is active', () => {
    const toolsWithAlwaysLoad = [
      ...mcpTools,
      {
        callableName: 'mcp__db__always_tool',
        rawName: 'always_tool',
        serverName: 'db',
        description: 'Always loaded',
        inputSchema: { type: 'object', properties: {} },
        annotations: { alwaysLoad: true },
      },
    ]
    const mcpRegistry = { list: () => toolsWithAlwaysLoad }
    const state = createLoopState()
    const tools = buildTools({ modelId: 'test:model', mcpRegistry } as any, state, LARGE_CTX)

    expect(state.deferredCatalog?.some((entry) => entry.name === 'mcp__db__query_rows')).toBe(true)
    expect(tools).toHaveProperty('mcp__db__always_tool')
    expect(tools).not.toHaveProperty('mcp__db__query_rows')
  })

  it('reuses the deferred catalog until the tool surface is invalidated', () => {
    const mcpRegistry = { list: () => mcpTools }
    const state = createLoopState()

    buildTools({ modelId: 'test:model', mcpRegistry } as any, state, LARGE_CTX)
    const firstCatalog = state.deferredCatalog
    buildTools({ modelId: 'test:model', mcpRegistry } as any, state, LARGE_CTX)

    expect(firstCatalog).toBeDefined()
    expect(state.deferredCatalog).toBe(firstCatalog)

    state.deferredCatalog = undefined
    buildTools({ modelId: 'test:model', mcpRegistry } as any, state, LARGE_CTX)
    expect(state.deferredCatalog).not.toBe(firstCatalog)
  })

  it('includes searchHint from annotations in searchText', () => {
    const toolsWithHint = [
      {
        callableName: 'mcp__s3__put_object',
        rawName: 'put_object',
        serverName: 's3',
        description: 'Upload to S3',
        inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
        annotations: { searchHint: 'upload file to cloud storage' },
      },
    ]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts = { mcpRegistry: { list: () => toolsWithHint } } as any
    const catalog = buildDeferredCatalog(opts, LARGE_CTX)
    const s3Tool = catalog.find((e) => e.name === 'mcp__s3__put_object')
    expect(s3Tool!.searchText).toContain('upload file to cloud storage')
    expect(searchDeferredTools('upload cloud', catalog, 5)).toContain('mcp__s3__put_object')
  })

  it('defers task but keeps todo direct only for an explicit supported standard profile', () => {
    const subAgentRegistry = {
      list: () => [{ name: 'reviewer', description: 'Review changes' }],
      names: () => ['reviewer'],
    }
    const state = createLoopState()
    const tools = buildTools(
      {
        modelId: 'anthropic:claude-sonnet-5',
        toolProfile: 'standard',
        subAgentRegistry,
      } as any,
      state,
      1_000_000,
    )

    expect(state.deferredCatalog?.map((entry) => entry.name)).toContain('task')
    expect(tools).not.toHaveProperty('task')
    expect(tools).toHaveProperty('todoWrite')
    expect(tools).toHaveProperty('toolSearch')
  })

  it('reduces the directly injected schema surface by at least fifteen percent', () => {
    const subAgentRegistry = {
      list: () => [{ name: 'reviewer', description: 'Review changes' }],
      names: () => ['reviewer'],
    }
    const full = buildTools(
      { modelId: 'anthropic:claude-sonnet-5', toolProfile: 'full', subAgentRegistry } as any,
      createLoopState(),
      1_000_000,
    )
    const standard = buildTools(
      { modelId: 'anthropic:claude-sonnet-5', toolProfile: 'standard', subAgentRegistry } as any,
      createLoopState(),
      1_000_000,
    )
    const wireSize = (tools: Record<string, unknown>) =>
      Object.entries(tools).reduce(
        (sum, [name, definition]) => sum + name.length + JSON.stringify(definition).length,
        0,
      )

    expect(wireSize(standard)).toBeLessThan(wireSize(full) * 0.85)
  })
})

describe('isWeakModel', () => {
  it('detects haiku as weak', () => {
    expect(isWeakModel('anthropic:claude-haiku-4-5')).toBe(true)
  })
  it('detects nano as weak', () => {
    expect(isWeakModel('openai:gpt-5.4-nano')).toBe(true)
  })
  it('does not flag strong models', () => {
    expect(isWeakModel('anthropic:claude-sonnet-5')).toBe(false)
    expect(isWeakModel('openai:gpt-5.6-sol')).toBe(false)
    expect(isWeakModel('deepseek:deepseek-v4-pro')).toBe(false)
  })
})

describe('resolveEffectiveToolProfile', () => {
  it('defaults to full and honors standard only for allowlisted strong models', () => {
    expect(resolveEffectiveToolProfile(undefined, 'anthropic:claude-sonnet-5')).toBe('full')
    expect(resolveEffectiveToolProfile('full', 'anthropic:claude-sonnet-5')).toBe('full')
    expect(resolveEffectiveToolProfile('standard', 'anthropic:claude-sonnet-5')).toBe('standard')
    expect(resolveEffectiveToolProfile('standard', 'openai:gpt-5.6-sol')).toBe('standard')
  })

  it('falls back to full for weak, unknown, and custom models', () => {
    expect(resolveEffectiveToolProfile('standard', 'anthropic:claude-haiku-4-5')).toBe('full')
    expect(resolveEffectiveToolProfile('standard', 'custom:anything')).toBe('full')
    expect(resolveEffectiveToolProfile('standard', 'future:unknown')).toBe('full')
  })
})

describe('runToolSearch with pendingServers', () => {
  it('includes pending server hint when no matches found', () => {
    const r = runToolSearch('quantum teleporter', 5, CATALOG, ['slow-mcp-server'])
    expect(r.text).toContain('slow-mcp-server')
    expect(r.text).toContain('still connecting')
  })

  it('does not include pending hint when matches are found', () => {
    const r = runToolSearch('create issue', 5, CATALOG, ['slow-mcp-server'])
    expect(r.text).not.toContain('still connecting')
  })
})
