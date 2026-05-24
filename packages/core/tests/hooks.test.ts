// Tests for hooks subsystem: variables, config-schema, registry, bus,
// executor (via a real node subprocess to exercise the stdin/stdout
// protocol portably).
import { describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  HookBus,
  HookConfigParseError,
  HookRegistry,
  aggregatePostToolUse,
  aggregatePreToolUse,
  aggregateUserPromptSubmit,
  buildHookRegistry,
  buildVariableContext,
  executeHook,
  expandVariables,
  parseHookConfig,
} from '../src/hooks/index.js'
import type { HookEvent, RegisteredHook } from '../src/hooks/index.js'

// ── variables ───────────────────────────────────────────────────────────

describe('expandVariables', () => {
  const ctx = buildVariableContext({ pluginDir: '/abs/plugin', cwd: '/abs/cwd' })

  it('expands the four built-in names', () => {
    expect(expandVariables('${pluginDir}/run', ctx)).toBe('/abs/plugin/run')
    expect(expandVariables('cd ${cwd}', ctx)).toBe('cd /abs/cwd')
    expect(expandVariables('home=${homedir}', ctx)).toContain('home=')
    expect(expandVariables('s${sep}', ctx)).toBe(`s${path.sep}`)
  })

  it('reads ${env:NAME} from process.env', () => {
    process.env.XC_HOOK_TEST_VAR = 'hello'
    try {
      expect(expandVariables('echo ${env:XC_HOOK_TEST_VAR}', ctx)).toBe('echo hello')
    } finally {
      delete process.env.XC_HOOK_TEST_VAR
    }
  })

  it('leaves unknown variables verbatim (typos surface as shell errors, not silent expansion)', () => {
    expect(expandVariables('${nope}', ctx)).toBe('${nope}')
    expect(expandVariables('${unknown:foo}', ctx)).toBe('${unknown:foo}')
  })

  it('${pluginDataDir} expands and auto-creates the dir when pluginId is supplied', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-data-ctx-'))
    const prev = process.env.XC_PLUGINS_DIR
    process.env.XC_PLUGINS_DIR = tmpHome
    try {
      const c = buildVariableContext({
        pluginDir: '/abs/plugin',
        cwd: '/abs/cwd',
        pluginId: 'demo@local',
      })
      const expanded = expandVariables('write ${pluginDataDir}/state.json', c)
      // The expanded path must live under our temp plugins root.
      expect(expanded.startsWith('write ')).toBe(true)
      const dataPath = expanded.slice('write '.length).replace(/\/state\.json$/, '')
      const stat = await fs.stat(dataPath)
      expect(stat.isDirectory()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.XC_PLUGINS_DIR
      else process.env.XC_PLUGINS_DIR = prev
      await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('${pluginDataDir} stays verbatim when no pluginId was supplied (e.g. hook with no owner context)', () => {
    const c = buildVariableContext({ pluginDir: '/abs/plugin', cwd: '/abs/cwd' })
    expect(expandVariables('${pluginDataDir}/state', c)).toBe('${pluginDataDir}/state')
  })
})

// ── config-schema ──────────────────────────────────────────────────────

describe('parseHookConfig', () => {
  it('strips unknown event names (forward compat)', () => {
    const c = parseHookConfig({ PreToolUse: [{ command: 'a' }], SomeFutureEvent: [{ command: 'b' }] }, 'demo')
    expect(c.PreToolUse).toBeDefined()
    expect((c as Record<string, unknown>).SomeFutureEvent).toBeUndefined()
  })

  it('rejects entries missing a command', () => {
    expect(() => parseHookConfig({ PreToolUse: [{ matcher: 'edit_file' }] }, 'demo')).toThrow(HookConfigParseError)
  })

  it('caps timeout at 30 seconds', () => {
    expect(() => parseHookConfig({ PreToolUse: [{ command: 'x', timeout: 60_000 }] }, 'demo')).toThrow(
      HookConfigParseError,
    )
  })

  it('accepts the 4 new event names (PreCompact / PostCompact / SubagentStart / SubagentStop)', () => {
    const c = parseHookConfig(
      {
        PreCompact: [{ command: 'echo pre' }],
        PostCompact: [{ command: 'echo post' }],
        SubagentStart: [{ command: 'echo start' }],
        SubagentStop: [{ command: 'echo stop' }],
      },
      'demo',
    )
    expect(c.PreCompact?.[0]?.command).toBe('echo pre')
    expect(c.PostCompact?.[0]?.command).toBe('echo post')
    expect(c.SubagentStart?.[0]?.command).toBe('echo start')
    expect(c.SubagentStop?.[0]?.command).toBe('echo stop')
  })

  it('accepts the platform-specific command overrides', () => {
    const c = parseHookConfig(
      {
        PreToolUse: [
          {
            command: 'node script.js',
            commandWindows: 'node "script.js"',
            commandDarwin: 'node script.js',
            commandLinux: 'node script.js',
          },
        ],
      },
      'demo',
    )
    expect(c.PreToolUse?.[0]?.commandWindows).toBe('node "script.js"')
    expect(c.PreToolUse?.[0]?.commandDarwin).toBe('node script.js')
  })
})

// ── registry ───────────────────────────────────────────────────────────

describe('buildHookRegistry', () => {
  it('groups hooks by event in registration order', () => {
    const reg = buildHookRegistry([
      { pluginId: 'a@local', pluginDir: '/a', config: { PreToolUse: [{ command: 'a1' }, { command: 'a2' }] } },
      { pluginId: 'b@local', pluginDir: '/b', config: { PreToolUse: [{ command: 'b1' }] } },
    ])
    const list = reg.get('PreToolUse')
    expect(list.map((h) => h.entry.command)).toEqual(['a1', 'a2', 'b1'])
    expect(list.map((h) => h.pluginId)).toEqual(['a@local', 'a@local', 'b@local'])
  })
})

// ── aggregators ────────────────────────────────────────────────────────

describe('aggregate helpers', () => {
  it('aggregatePreToolUse stops at first deny', () => {
    const eff = aggregatePreToolUse([
      { decision: 'allow' },
      { decision: 'deny', reason: 'no' },
      { decision: 'modify', args: { x: 1 } }, // ignored — comes after deny
    ])
    expect(eff.decision).toBe('deny')
    expect(eff.reason).toBe('no')
  })

  it('aggregatePreToolUse stacks modify args (later wins)', () => {
    const eff = aggregatePreToolUse([
      { decision: 'modify', args: { x: 1 } },
      { decision: 'modify', args: { x: 2, y: 3 } },
    ])
    expect(eff.decision).toBe('allow')
    expect(eff.args).toEqual({ x: 2, y: 3 })
  })

  it('aggregatePostToolUse uses last modify.output', () => {
    const eff = aggregatePostToolUse([
      { decision: 'modify', output: 'first' },
      { decision: 'modify', output: 'second' },
    ])
    expect(eff.output).toBe('second')
  })

  it('aggregateUserPromptSubmit concatenates contexts', () => {
    const eff = aggregateUserPromptSubmit([
      { decision: 'allow', context: 'a' },
      { decision: 'modify', context: 'b' },
    ])
    expect(eff.decision).toBe('allow')
    expect(eff.context).toBe('a\n\nb')
  })

  it('aggregateUserPromptSubmit deny clears context', () => {
    const eff = aggregateUserPromptSubmit([
      { decision: 'allow', context: 'a' },
      { decision: 'deny', reason: 'sensitive' },
    ])
    expect(eff.decision).toBe('deny')
    expect(eff.context).toBe('')
  })
})

// ── bus matcher ────────────────────────────────────────────────────────

describe('HookBus matcher behaviour', () => {
  function makeHook(matcher: string | undefined, command = 'node -e "process.exit(0)"'): RegisteredHook {
    return {
      pluginId: 'demo@local',
      pluginDir: process.cwd(),
      event: 'PreToolUse',
      entry: { command, matcher },
    }
  }

  it('filters by matcher regex (PreToolUse only)', async () => {
    // We exercise the matcher filter at the bus level — to avoid spawning
    // shell processes, use commands that exit 0 immediately so any matched
    // hook runs successfully.
    const reg = new HookRegistry([makeHook('write_file', 'node -e "process.exit(0)"')])
    const bus = new HookBus(reg)

    // No match: empty decisions array (no hook ran).
    const noMatch = await bus.emit({
      name: 'PreToolUse',
      session: { cwd: process.cwd(), modelId: 'm' },
      tool: { name: 'edit_file', args: {}, callId: 'c1' },
    })
    expect(noMatch).toEqual([])

    // Match: one hook ran (we got one decision back).
    const match = await bus.emit({
      name: 'PreToolUse',
      session: { cwd: process.cwd(), modelId: 'm' },
      tool: { name: 'write_file', args: {}, callId: 'c2' },
    })
    expect(match).toHaveLength(1)
    expect(match[0]!.decision).toBe('allow')
  }, 15_000)

  it('treats bad-regex matcher as "match all" (degrade rather than disable)', async () => {
    const reg = new HookRegistry([makeHook('(', 'node -e "process.exit(0)"')])
    const bus = new HookBus(reg)
    const decisions = await bus.emit({
      name: 'PreToolUse',
      session: { cwd: process.cwd(), modelId: 'm' },
      tool: { name: 'anything', args: {}, callId: 'c' },
    })
    expect(decisions).toHaveLength(1)
  }, 15_000)
})

// ── executor (real subprocess) ─────────────────────────────────────────

describe('executeHook (real subprocess)', () => {
  async function writeHookScript(contents: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-hook-script-'))
    const file = path.join(dir, 'hook.js')
    await fs.writeFile(file, contents, 'utf-8')
    return file
  }

  function hookFor(file: string, overrides: Partial<RegisteredHook['entry']> = {}): RegisteredHook {
    return {
      pluginId: 'demo@local',
      pluginDir: process.cwd(),
      event: 'PreToolUse',
      entry: { command: `node "${file}"`, ...overrides },
    }
  }

  function preEvent(): HookEvent {
    return {
      name: 'PreToolUse',
      session: { cwd: process.cwd(), modelId: 'm' },
      tool: { name: 'write_file', args: { path: 'a.txt' }, callId: 'c1' },
    }
  }

  it('reads stdin event JSON and returns parsed decision JSON from stdout', async () => {
    const script = await writeHookScript(`
      let data = ''
      process.stdin.on('data', (c) => { data += c })
      process.stdin.on('end', () => {
        const e = JSON.parse(data)
        if (e.tool && e.tool.name === 'write_file') {
          console.log(JSON.stringify({ decision: 'deny', reason: 'no writes today' }))
        } else {
          console.log(JSON.stringify({ decision: 'allow' }))
        }
      })
    `)
    const d = await executeHook(hookFor(script), preEvent())
    expect(d.decision).toBe('deny')
    if (d.decision === 'deny') expect(d.reason).toBe('no writes today')
  }, 15_000)

  it('treats empty stdout as default allow', async () => {
    const script = await writeHookScript('process.exit(0)')
    const d = await executeHook(hookFor(script), preEvent())
    expect(d.decision).toBe('allow')
  }, 15_000)

  it('failurePolicy:allow → non-zero exit becomes allow', async () => {
    const script = await writeHookScript('process.exit(7)')
    const d = await executeHook(hookFor(script), preEvent())
    expect(d.decision).toBe('allow')
  }, 15_000)

  it('failurePolicy:block → non-zero exit becomes deny', async () => {
    const script = await writeHookScript('process.exit(7)')
    const d = await executeHook(hookFor(script, { failurePolicy: 'block' }), preEvent())
    expect(d.decision).toBe('deny')
  }, 15_000)

  it('picks the platform-specific command over the base when current OS matches', async () => {
    // Each candidate emits a unique reason so we can tell which one ran.
    // Whichever process.platform we're on, the matching override wins.
    const base = await writeHookScript('console.log(JSON.stringify({decision:"deny",reason:"BASE"}))')
    const win = await writeHookScript('console.log(JSON.stringify({decision:"deny",reason:"WIN"}))')
    const mac = await writeHookScript('console.log(JSON.stringify({decision:"deny",reason:"MAC"}))')
    const lin = await writeHookScript('console.log(JSON.stringify({decision:"deny",reason:"NIX"}))')

    const hook: RegisteredHook = {
      pluginId: 'demo@local',
      pluginDir: process.cwd(),
      event: 'PreToolUse',
      entry: {
        command: `node "${base}"`,
        commandWindows: `node "${win}"`,
        commandDarwin: `node "${mac}"`,
        commandLinux: `node "${lin}"`,
      },
    }
    const d = await executeHook(hook, preEvent())
    expect(d.decision).toBe('deny')
    const expected =
      process.platform === 'win32'
        ? 'WIN'
        : process.platform === 'darwin'
          ? 'MAC'
          : process.platform === 'linux'
            ? 'NIX'
            : 'BASE'
    if (d.decision === 'deny') expect(d.reason).toBe(expected)
  }, 15_000)

  it('falls back to base command when current OS has no override', async () => {
    const base = await writeHookScript('console.log(JSON.stringify({decision:"deny",reason:"BASE-WINS"}))')
    // Set overrides only for OSes that we're NOT on.
    const other = await writeHookScript('console.log(JSON.stringify({decision:"deny",reason:"OTHER"}))')
    const hook: RegisteredHook = {
      pluginId: 'demo@local',
      pluginDir: process.cwd(),
      event: 'PreToolUse',
      entry: {
        command: `node "${base}"`,
        commandWindows: process.platform === 'win32' ? undefined : `node "${other}"`,
        commandDarwin: process.platform === 'darwin' ? undefined : `node "${other}"`,
        commandLinux: process.platform === 'linux' ? undefined : `node "${other}"`,
      },
    }
    const d = await executeHook(hook, preEvent())
    expect(d.decision).toBe('deny')
    if (d.decision === 'deny') expect(d.reason).toBe('BASE-WINS')
  }, 15_000)
})
