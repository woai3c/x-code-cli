import { createLoopState } from '../src/agent/loop-state.js'
import { buildTools } from '../src/agent/loop.js'
import { SubAgentRegistry } from '../src/agent/sub-agents/registry.js'
import type { SubAgentDefinition } from '../src/agent/sub-agents/types.js'

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
