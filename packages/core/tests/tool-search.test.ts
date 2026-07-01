// Tests for the deferred-tool / toolSearch machinery: keyword scoring,
// the select: exact-load path, catalog construction, and per-turn composition.
import { describe, expect, it, vi } from 'vitest'

import {
  DEFERRED_BUILTIN_TOOLS,
  type DeferredToolEntry,
  buildDeferredCatalog,
  composeTurnTools,
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
})

describe('buildDeferredCatalog', () => {
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
    const catalog = buildDeferredCatalog(options)
    const names = catalog.map((e) => e.name)
    for (const name of DEFERRED_BUILTIN_TOOLS) expect(names).toContain(name)
    expect(names).toContain('listMcpResources')
    expect(names).toContain('readMcpResource')
  })

  it('includes MCP tools and folds their schema property names into searchText', () => {
    const catalog = buildDeferredCatalog(options)
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
    const catalog = buildDeferredCatalog({} as any)
    const names = catalog.map((e) => e.name)
    expect(names).not.toContain('listMcpResources')
    expect(names).toContain('webSearch')
  })
})
