import { createLoopState } from '../src/agent/loop-state.js'
import { buildTools } from '../src/agent/loop.js'
import { SubAgentRegistry } from '../src/agent/sub-agents/registry.js'
import { buildSubAgentToolFilter, cleanupSubAgentShellSessions } from '../src/agent/sub-agents/runner.js'
import type { SubAgentDefinition } from '../src/agent/sub-agents/types.js'
import type { ShellSessionController, TerminateAllResult } from '../src/tools/shell-session/types.js'

function definition(overrides: Partial<SubAgentDefinition> = {}): SubAgentDefinition {
  return {
    name: 'custom',
    description: 'test agent',
    prompt: 'test',
    maxTurns: 1,
    source: 'project',
    ...overrides,
  }
}

describe('sub-agent shell transport closure', () => {
  it('keeps omitted, wildcard, and explicit tool allowlists distinct', () => {
    expect(buildSubAgentToolFilter(definition(), 'default')).toEqual({ allow: undefined, deny: ['task'] })
    expect(buildSubAgentToolFilter(definition({ tools: ['*'] }), 'default')).toEqual({
      allow: undefined,
      deny: ['task'],
    })
    expect(buildSubAgentToolFilter(definition({ tools: ['readFile'] }), 'default')).toEqual({
      allow: ['readFile'],
      deny: ['task'],
    })
  })

  it('retries unconfirmed cleanup, transfers ownership, and reports the residual shell', async () => {
    const residual: TerminateAllResult = {
      managerInstanceId: '1'.repeat(32),
      reason: 'subagent-finished',
      requested: 1,
      confirmed: 0,
      alreadyExited: 0,
      results: [
        {
          managerInstanceId: '1'.repeat(32),
          shellId: `bg_${'1'.repeat(32)}_1`,
          reason: 'subagent-finished',
          disposition: 'still-running',
          gracefulAttempted: true,
          forceAttempted: true,
          rootExited: false,
          treeConfirmedExited: false,
          terminationConfirmed: false,
          failure: { code: 'termination-unconfirmed', message: 'fixture remains live' },
          output: '',
        },
      ],
    }
    const child = {
      dispose: vi.fn().mockResolvedValue(residual),
    } as unknown as ShellSessionController
    const parent = {
      adoptResidualManager: vi.fn((_manager, shellIds: readonly string[]) => [...shellIds]),
    } as unknown as ShellSessionController

    const failure = await cleanupSubAgentShellSessions(parent, child, 'fixture-agent')

    expect(child.dispose).toHaveBeenCalledTimes(2)
    expect(parent.adoptResidualManager).toHaveBeenCalledWith(child, [residual.results[0]!.shellId])
    expect(failure).toMatchObject({ shellIds: [residual.results[0]!.shellId] })
    expect(failure?.message).toContain('Use /ps to inspect and /stop to retry')
  })

  it.each([undefined, ['*'], ['shell']])(
    'rejects a shell-capable definition that denies a transport when tools is %j',
    (tools) => {
      const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const registry = new SubAgentRegistry([definition({ tools, disallowedTools: ['shellOutput'] })])
        expect(registry.get('custom')).toBeUndefined()
        expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('unmanageable shell capability'))
      } finally {
        diagnostic.mockRestore()
      }
    },
  )

  it('removes the whole shell capability when a runtime filter bypasses registry validation', async () => {
    const state = createLoopState('default', { projectCwd: process.cwd() })
    try {
      const tools = buildTools(
        { modelId: 'test-model', trustMode: true, printMode: false, toolFilter: { deny: ['shellOutput'] } },
        state,
      )
      expect(tools.shell).toBeUndefined()
      expect(tools.shellOutput).toBeUndefined()
      expect(tools.killShell).toBeUndefined()
    } finally {
      await state.shellSessions.dispose('manager-dispose')
    }
  })
})
