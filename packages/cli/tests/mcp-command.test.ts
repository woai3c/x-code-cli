import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { getMcpConfigPath, isProjectTrusted, serverExists } from '@x-code-cli/core'
import type { AgentOptions, McpRegistry } from '@x-code-cli/core'

import { createMcpCommandHandler } from '../src/ui/app/commands/mcp.js'

describe('/mcp command handler', () => {
  const tempDirs: string[] = []
  let originalXcodeHome: string | undefined
  let originalCwd: string

  async function makeTempDir(prefix: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
    tempDirs.push(dir)
    return dir
  }

  beforeEach(async () => {
    originalXcodeHome = process.env.X_CODE_HOME
    originalCwd = process.cwd()
    const home = await makeTempDir('xc-mcp-cmd-home-')
    const repo = await makeTempDir('xc-mcp-cmd-repo-')
    process.env.X_CODE_HOME = home
    process.chdir(repo)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    if (originalXcodeHome === undefined) delete process.env.X_CODE_HOME
    else process.env.X_CODE_HOME = originalXcodeHome
    for (const dir of tempDirs.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('adds user and project MCP servers, blocks same-scope duplicates, and auto-trusts project scope', async () => {
    const messages: string[] = []
    const { handleMcp } = createMcpCommandHandler({
      options: {} as AgentOptions,
      addCommandMessage: (_text, content) => messages.push(content),
      addCommandResult: (content) => messages.push(content),
      askQuestion: vi.fn(async () => 'Cancel'),
      invalidateSystemPromptCache: vi.fn(),
    })

    await handleMcp('/mcp add fs -- node server.js', 'add fs -- node server.js')
    expect(messages.at(-1)).toContain('Added MCP server "fs" (stdio)')
    expect(await serverExists('fs', 'user', process.cwd())).toBe(true)

    // Duplicate in same scope is blocked with removal guidance
    await handleMcp('/mcp add fs -- node other.js', 'add fs -- node other.js')
    expect(messages.at(-1)).toContain('Server "fs" already exists in user scope')

    // Cross-scope coexistence is allowed, and --scope project auto-trusts the workspace
    expect(await isProjectTrusted(process.cwd())).toBe(false)
    await handleMcp(
      '/mcp add --scope project --transport http fs https://mcp.example.com/sse',
      'add --scope project --transport http fs https://mcp.example.com/sse',
    )
    expect(messages.at(-1)).toContain('Added MCP server "fs" (http)')
    expect(messages.at(-1)).toContain('Auto-trusted this project for future launches.')
    expect(await serverExists('fs', 'project', process.cwd())).toBe(true)
    expect(await isProjectTrusted(process.cwd())).toBe(true)
  })

  it('requires explicit --scope when removing an ambiguous server and honours confirmation/cancellation', async () => {
    const messages: string[] = []
    let nextAnswer = 'Cancel'
    const { handleMcp } = createMcpCommandHandler({
      options: {} as AgentOptions,
      addCommandMessage: (_text, content) => messages.push(content),
      addCommandResult: (content) => messages.push(content),
      askQuestion: vi.fn(async () => nextAnswer),
      invalidateSystemPromptCache: vi.fn(),
    })

    await handleMcp(
      '/mcp add-json api \'{"url":"https://api.example.com/mcp"}\'',
      'add-json api \'{"url":"https://api.example.com/mcp"}\'',
    )
    await handleMcp(
      '/mcp add-json --scope project api \'{"url":"https://staging.example.com/mcp"}\'',
      'add-json --scope project api \'{"url":"https://staging.example.com/mcp"}\'',
    )

    // Ambiguous across scopes -> asks user to disambiguate without deleting either
    await handleMcp('/mcp remove api', 'remove api')
    expect(messages.at(-1)).toContain('exists at both scopes. Specify --scope user or --scope project.')

    // Explicit scope + Cancel keeps entry intact
    nextAnswer = 'Cancel'
    await handleMcp('/mcp remove --scope user api', 'remove --scope user api')
    expect(messages.at(-1)).toContain('Cancelled — "api" not removed.')
    expect(await serverExists('api', 'user', process.cwd())).toBe(true)

    // Explicit scope + Remove deletes only the targeted scope
    nextAnswer = 'Remove'
    await handleMcp('/mcp remove --scope user api', 'remove --scope user api')
    expect(messages.at(-1)).toContain(`Removed "api" from user scope (${getMcpConfigPath('user', process.cwd())}).`)
    expect(await serverExists('api', 'user', process.cwd())).toBe(false)
    expect(await serverExists('api', 'project', process.cwd())).toBe(true)
  })

  it('lists server statuses/tools, refreshes disk config into registry, and invalidates prompt cache', async () => {
    const messages: string[] = []
    const invalidateSystemPromptCache = vi.fn()
    const restartAll = vi.fn(async (configs: Map<string, unknown>) => ({
      added: [...configs.keys()],
      removed: [],
      changed: [],
      unchanged: [],
    }))
    const mcpRegistry = {
      serverStatus: () => [
        { name: 'github', status: { kind: 'connected' as const, toolCount: 2, resourceCount: 1 } },
        { name: 'broken', status: { kind: 'failed' as const, error: 'spawn ENOENT' } },
      ],
      list: () => [
        { callableName: 'github__list_prs', serverName: 'github', description: 'List pull requests' },
        { callableName: 'other__ping', serverName: 'other', description: 'Ping' },
      ],
      getConfig: (name: string) =>
        name === 'stdio-srv' ? { command: 'node', args: ['srv.js'] } : { url: 'https://oauth.example.com/mcp' },
      authenticateServer: vi.fn(async () => ({
        name: 'http-srv',
        status: { kind: 'connected' as const, toolCount: 3, resourceCount: 0 },
      })),
      restartAll,
    } as unknown as McpRegistry

    const { handleMcp } = createMcpCommandHandler({
      options: { mcpRegistry } as AgentOptions,
      addCommandMessage: (_text, content) => messages.push(content),
      addCommandResult: (content) => messages.push(content),
      askQuestion: vi.fn(async () => 'Trust'),
      invalidateSystemPromptCache,
    })

    await handleMcp('/mcp list', 'list')
    expect(messages.at(-1)).toMatch(/github\s+connected — 2 tools, 1 resource/)
    expect(messages.at(-1)).toMatch(/broken\s+failed — spawn ENOENT/)

    await handleMcp('/mcp tools github', 'tools github')
    expect(messages.at(-1)).toContain('github__list_prs — List pull requests')
    expect(messages.at(-1)).not.toContain('other__ping')

    // OAuth rejected on stdio servers, accepted on HTTP servers with cache invalidation
    await handleMcp('/mcp auth stdio-srv', 'auth stdio-srv')
    expect(messages.at(-1)).toContain('OAuth applies to HTTP servers')
    expect(invalidateSystemPromptCache).not.toHaveBeenCalled()

    await handleMcp('/mcp auth http-srv', 'auth http-srv')
    expect(messages.at(-1)).toContain('✓ Authenticated "http-srv" — 3 tools, 0 resources')
    expect(invalidateSystemPromptCache).toHaveBeenCalledTimes(1)

    // Add a user server on disk and run /mcp refresh -> restartAll receives merged config and invalidates cache
    await handleMcp('/mcp add local-tools -- node tools.js', 'add local-tools -- node tools.js')
    await handleMcp('/mcp refresh', 'refresh')
    const passedConfigs = restartAll.mock.calls[0]?.[0] as Map<string, unknown>
    expect(passedConfigs.get('local-tools')).toEqual({ command: 'node', args: ['tools.js'] })
    expect(messages.at(-1)).toContain('Reloaded MCP — added: local-tools.')
    expect(invalidateSystemPromptCache).toHaveBeenCalledTimes(2)
  })
})
