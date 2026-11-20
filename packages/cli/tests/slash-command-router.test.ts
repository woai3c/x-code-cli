import { describe, expect, it, vi } from 'vitest'

import type { CommandDefinition, SkillDefinition } from '@x-code-cli/core'

import { SLASH_COMMANDS, buildHelpText } from '../src/ui/app/command-content.js'
import { routeSlashCommand } from '../src/ui/app/commands/router.js'

function makeRouter(overrides: Partial<Parameters<typeof routeSlashCommand>[1]> = {}) {
  const commandMessages: Array<{ text: string; content: string }> = []
  const commandResults: string[] = []
  const infoMessages: string[] = []
  const echoed: string[] = []
  const submitted: Array<{ prompt: string; silent?: boolean }> = []
  const pendingSkillRef: { current: SkillDefinition | null } = { current: null }

  const agent = {
    addCommandMessage: vi.fn((text: string, content: string) => commandMessages.push({ text, content })),
    addCommandResult: vi.fn((content: string) => commandResults.push(content)),
    addInfoMessage: vi.fn((content: string) => infoMessages.push(content)),
    clear: vi.fn(async () => ({ ok: true as const })),
    clearPeerContext: vi.fn(async () => ({ ok: true, removed: 2 })),
    echoCommand: vi.fn((text: string) => echoed.push(text)),
    fork: vi.fn(async () => ({
      ok: true as const,
      sessionId: '20261120-100000-000',
      messageCount: 6,
      excludedActiveTurn: false,
    })),
    listShellSessions: vi.fn(() => []),
    stopShellSessions: vi.fn(async () => ({
      stopped: [],
      alreadyExited: [],
      unconfirmed: [],
      notFound: [],
    })),
    submit: vi.fn(async (prompt: string, opts?: { silent?: boolean }) => {
      submitted.push({ prompt, silent: opts?.silent })
    }),
    ...overrides.agent,
  }

  const handlers = {
    login: vi.fn(async () => undefined),
    logout: vi.fn(async () => undefined),
    model: vi.fn(async () => undefined),
    agent: vi.fn(async () => undefined),
    context: vi.fn(),
    thinking: vi.fn(async () => undefined),
    theme: vi.fn(async () => undefined),
    plan: vi.fn(),
    compact: vi.fn(async () => undefined),
    goal: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    rewind: vi.fn(async () => undefined),
    usage: vi.fn(async () => undefined),
    usageHistory: vi.fn(async () => undefined),
    memory: vi.fn(async () => undefined),
    skill: vi.fn(async () => undefined),
    mcp: vi.fn(async () => undefined),
    plugin: vi.fn(async () => undefined),
    browser: vi.fn(async () => undefined),
    doctor: vi.fn(),
    ...overrides.handlers,
  }

  const router: Parameters<typeof routeSlashCommand>[1] = {
    agent: agent as any,
    options: overrides.options ?? {},
    skillCommands: overrides.skillCommands ?? [],
    fileCommands: overrides.fileCommands ?? [],
    pendingSkillRef,
    handlers,
    exit: overrides.exit ?? vi.fn(),
  }

  return {
    router,
    agent,
    handlers,
    pendingSkillRef,
    commandMessages,
    commandResults,
    infoMessages,
    echoed,
    submitted,
  }
}

describe('slash command router and help surface', () => {
  it('advertises core session, auth, and extensibility commands in completion and /help', async () => {
    const names = SLASH_COMMANDS.map((c) => c.name)
    for (const expected of ['/login', '/logout', '/rewind', '/fork', '/mcp', '/plugin', '/doctor']) {
      expect(names).toContain(expected)
    }

    const { router, infoMessages } = makeRouter({
      skillCommands: [{ name: 'audit', description: 'Run security audit' }],
      fileCommands: [{ name: 'deploy', description: 'Deploy preview' }],
    })
    await routeSlashCommand('/help', router)
    expect(infoMessages[0]).toBe(
      buildHelpText(
        [{ name: 'audit', description: 'Run security audit' }],
        [{ name: 'deploy', description: 'Deploy preview' }],
      ),
    )
    expect(infoMessages[0]).toContain('/login')
    expect(infoMessages[0]).toContain('/audit')
    expect(infoMessages[0]).toContain('/deploy')
  })

  it('routes auth commands, /clear failure details, and /fork named/active-turn messaging', async () => {
    const ctx = makeRouter({
      agent: {
        clear: vi.fn(async () => ({
          ok: false as const,
          reason: 'background shell still active',
        })),
        fork: vi.fn(async (name?: string) => ({
          ok: true as const,
          sessionId: '20261120-103000-001',
          messageCount: 4,
          excludedActiveTurn: true,
          ...(name ? { name } : {}),
        })),
      } as any,
    })

    await routeSlashCommand('/login --device-auth', ctx.router)
    await routeSlashCommand('/logout', ctx.router)
    expect(ctx.handlers.login).toHaveBeenCalledWith('/login --device-auth', '--device-auth')
    expect(ctx.handlers.logout).toHaveBeenCalledWith('/logout', '')

    const dummySkill = { name: 'tmp', description: 'd', content: 'b', dir: '/s', source: 'user' } as SkillDefinition
    ctx.pendingSkillRef.current = dummySkill
    await routeSlashCommand('/clear', ctx.router)
    expect(ctx.pendingSkillRef.current).toBeNull()
    expect(ctx.commandMessages.at(-1)?.content).toContain('Clear was not completed: background shell still active.')

    await routeSlashCommand('/fork hotfix-branch', ctx.router)
    expect(ctx.commandResults.at(-1)).toContain('Fork created: **hotfix-branch** (`20261120-103000-001`) (4 messages).')
    expect(ctx.commandResults.at(-1)).toContain('The active request remains only in the original session.')
    expect(ctx.commandResults.at(-1)).toContain('`xc --resume "hotfix-branch"`')
  })

  it('handles /clear-peer-context and /list-agents across unnamed, unavailable, and live peer states', async () => {
    const unnamed = makeRouter()
    await routeSlashCommand('/list-agents', unnamed.router)
    expect(unnamed.commandResults.at(-1)).toContain('Restart with --name <name>')

    const live = makeRouter({
      options: {
        peerService: {
          enabled: true,
          isAvailable: () => true,
          list: async () => ({
            partial: true,
            peers: [
              {
                name: 'worker-b',
                address: 'peer:2',
                status: 'busy',
                busyKind: 'user',
                cwd: '/b',
                startedAt: '2026-02',
              },
              { name: 'worker-a', address: 'peer:1', status: 'idle', cwd: '/a', startedAt: '2026-01' },
            ],
          }),
        } as any,
      },
    })
    await routeSlashCommand('/list-agents', live.router)
    expect(live.commandResults.at(-1)).toContain('worker-a · peer:1 · idle · /a\nworker-b · peer:2 · busy (user) · /b')
    expect(live.commandResults.at(-1)).toContain('Results may be partial')

    await routeSlashCommand('/clear-peer-context', live.router)
    expect(live.infoMessages.at(-1)).toBe('Removed 2 peer-influenced transcript message(s).')
  })

  it('activates /<skill> inline or in two steps, expands plugin file commands, and reports unknown commands', async () => {
    const skill: SkillDefinition = {
      name: 'refactor-guide',
      description: 'Refactor safely',
      content: 'Always preserve public exports.',
      dir: '/skills/refactor-guide',
      files: [],
      source: 'project',
    }
    const fileCmd: CommandDefinition = {
      name: 'check-pr',
      description: 'Check PR',
      body: 'Inspect PR #$ARGUMENTS carefully.',
      source: 'plugin',
    }

    const ctx = makeRouter({
      options: {
        skillRegistry: { get: (name: string) => (name === 'refactor-guide' ? skill : undefined) } as any,
        commandRegistry: { get: (name: string) => (name === 'check-pr' ? fileCmd : undefined) } as any,
      },
    })

    // Bare /refactor-guide stages pendingSkillRef without submitting yet
    await routeSlashCommand('/refactor-guide', ctx.router)
    expect(ctx.pendingSkillRef.current).toBe(skill)
    expect(ctx.commandMessages.at(-1)?.content).toContain('Skill **refactor-guide** loaded. Type your request.')
    expect(ctx.submitted).toHaveLength(0)

    // /refactor-guide <arg> submits wrapped skill + request immediately
    await routeSlashCommand('/refactor-guide clean up auth', ctx.router)
    expect(ctx.submitted).toHaveLength(1)
    expect(ctx.submitted[0]?.silent).toBe(true)
    expect(ctx.submitted[0]?.prompt).toContain('Always preserve public exports.')
    expect(ctx.submitted[0]?.prompt).toContain('clean up auth')

    // File-based command expands $ARGUMENTS
    await routeSlashCommand('/check-pr 42', ctx.router)
    expect(ctx.submitted.at(-1)?.prompt).toBe('Inspect PR #42 carefully.')

    // Unknown command gives helpful guidance
    await routeSlashCommand('/nonexistent', ctx.router)
    expect(ctx.commandMessages.at(-1)?.content).toBe(
      'Unknown command: /nonexistent. Type /help for available commands.',
    )
  })
})
