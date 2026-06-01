// Tests for the file-based slash command subsystem (loader / registry /
// body expansion). The real regression risk is `$ARGUMENTS` and
// `${CLAUDE_PLUGIN_ROOT}` substitution and frontmatter parsing of the
// `allowed-tools:` form Claude Code uses (long, comma-separated, often
// folded across lines).
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { CommandRegistry, expandCommandBody, loadPluginCommands } from '../src/commands/index.js'

async function writeCommand(dir: string, name: string, frontmatter: string, body: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${name}.md`), `---\n${frontmatter}\n---\n${body}`, 'utf-8')
}

/** loadPluginCommands now also scans `${X_CODE_HOME}/commands` and
 *  `<cwd>/.x-code/commands` — isolate every test under fresh empty dirs so
 *  the developer's real `~/.x-code/commands/` doesn't leak into assertions. */
let prevHome: string | undefined
let prevCwd: string
let isolatedHome: string
let isolatedCwd: string

beforeEach(async () => {
  prevHome = process.env.X_CODE_HOME
  prevCwd = process.cwd()
  isolatedHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmds-home-'))
  isolatedCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmds-cwd-'))
  process.env.X_CODE_HOME = isolatedHome
  process.chdir(isolatedCwd)
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.X_CODE_HOME
  else process.env.X_CODE_HOME = prevHome
  process.chdir(prevCwd)
  await fs.rm(isolatedHome, { recursive: true, force: true }).catch(() => {})
  await fs.rm(isolatedCwd, { recursive: true, force: true }).catch(() => {})
})

describe('loadPluginCommands', () => {
  it('loads each commands/<name>.md as a CommandDefinition with name = basename', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmds-'))
    await writeCommand(dir, 'code-review', 'description: Review code', 'Body of code-review')
    await writeCommand(dir, 'commit', 'description: Make a commit', 'Body of commit')

    const out = await loadPluginCommands({
      extraDirs: [{ dir, pluginId: 'demo@local', pluginRoot: '/abs/root' }],
    })

    expect(out.map((c) => c.name).sort()).toEqual(['code-review', 'commit'])
    const cr = out.find((c) => c.name === 'code-review')!
    expect(cr.description).toBe('Review code')
    expect(cr.body).toBe('Body of code-review')
    expect(cr.pluginId).toBe('demo@local')
    expect(cr.pluginRoot).toBe('/abs/root')
  })

  it('handles real Claude Code multi-line allowed-tools frontmatter without crashing', async () => {
    // This is the actual form from anthropics/claude-code's
    // code-review plugin — `allowed-tools` is comma-separated, often
    // long enough to wrap visually. Our minimal YAML parser folds
    // indented continuation lines; the value we read for
    // `allowed-tools` is currently ignored (no enforcement), but the
    // parse must not reject the whole file.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmds-allowed-'))
    await writeCommand(
      dir,
      'real-shape',
      'allowed-tools: Bash(gh issue view:*), Bash(gh search:*), mcp__github_inline_comment__create_inline_comment\ndescription: Code review',
      'Body',
    )

    const out = await loadPluginCommands({
      extraDirs: [{ dir, pluginId: 'demo@local', pluginRoot: '/r' }],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.description).toBe('Code review')
    expect(out[0]!.body).toBe('Body')
  })

  it('treats a file with no frontmatter as a body-only command (no description)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmds-nofm-'))
    await fs.writeFile(path.join(dir, 'bare.md'), 'just the body', 'utf-8')

    const out = await loadPluginCommands({
      extraDirs: [{ dir, pluginId: 'demo@local', pluginRoot: '/r' }],
    })
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('bare')
    expect(out[0]!.description).toBeUndefined()
    expect(out[0]!.body).toBe('just the body')
  })

  it("returns empty when the dir does not exist (broken plugin shouldn't crash boot)", async () => {
    const out = await loadPluginCommands({
      extraDirs: [{ dir: '/nonexistent', pluginId: 'ghost@local', pluginRoot: '/r' }],
    })
    expect(out).toEqual([])
  })

  it('scans user (~/.x-code/commands) and project (<cwd>/.x-code/commands) directories', async () => {
    await writeCommand(path.join(isolatedHome, 'commands'), 'usercmd', 'description: from user', 'user body')
    await writeCommand(
      path.join(isolatedCwd, '.x-code', 'commands'),
      'projcmd',
      'description: from project',
      'proj body',
    )

    const out = await loadPluginCommands()

    const byName = new Map(out.map((c) => [c.name, c]))
    expect(byName.get('usercmd')?.source).toBe('user')
    expect(byName.get('usercmd')?.description).toBe('from user')
    expect(byName.get('usercmd')?.pluginId).toBeUndefined()
    expect(byName.get('projcmd')?.source).toBe('project')
    expect(byName.get('projcmd')?.description).toBe('from project')
  })

  it('precedence: project overrides plugin overrides user on name conflict', async () => {
    // All three sources define `dup` — registry's last-write-wins should
    // surface the project version.
    await writeCommand(path.join(isolatedHome, 'commands'), 'dup', 'description: user', 'user-body')
    const pluginDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmds-plugin-'))
    await writeCommand(pluginDir, 'dup', 'description: plugin', 'plugin-body')
    await writeCommand(path.join(isolatedCwd, '.x-code', 'commands'), 'dup', 'description: project', 'project-body')

    const out = await loadPluginCommands({
      extraDirs: [{ dir: pluginDir, pluginId: 'p@m', pluginRoot: '/r' }],
    })
    const reg = new CommandRegistry(out)
    const winner = reg.get('dup')!
    expect(winner.source).toBe('project')
    expect(winner.body).toBe('project-body')

    await fs.rm(pluginDir, { recursive: true, force: true }).catch(() => {})
  })

  it('user / project commands have no pluginId, and ${CLAUDE_PLUGIN_ROOT} expands to empty', async () => {
    await writeCommand(
      path.join(isolatedHome, 'commands'),
      'echo',
      'description: echo it',
      'cd ${CLAUDE_PLUGIN_ROOT} && say $ARGUMENTS',
    )

    const out = await loadPluginCommands()
    const echo = out.find((c) => c.name === 'echo')!
    expect(echo.source).toBe('user')
    expect(echo.pluginId).toBeUndefined()
    expect(echo.pluginRoot).toBeUndefined()
    expect(expandCommandBody(echo, 'hi')).toBe('cd  && say hi')
  })
})

describe('expandCommandBody', () => {
  function cmd(body: string, root = '/abs/plugin'): import('../src/commands/types.js').CommandDefinition {
    return { name: 't', body, source: 'plugin', pluginId: 'demo@local', pluginRoot: root }
  }

  it('substitutes $ARGUMENTS and ${ARGUMENTS} with the user-typed argument string', () => {
    expect(expandCommandBody(cmd('Run: $ARGUMENTS'), '123')).toBe('Run: 123')
    expect(expandCommandBody(cmd('Run: ${ARGUMENTS}'), 'abc def')).toBe('Run: abc def')
  })

  it('substitutes ${CLAUDE_PLUGIN_ROOT} with the plugin root path', () => {
    const out = expandCommandBody(cmd('cd ${CLAUDE_PLUGIN_ROOT} && ./scripts/x.sh', '/abs/p'), '')
    expect(out).toBe('cd /abs/p && ./scripts/x.sh')
  })

  it('leaves $ARGUMENTS as empty string when no argument was given', () => {
    expect(expandCommandBody(cmd('"$ARGUMENTS"'), '')).toBe('""')
  })

  it('substitutes ${CLAUDE_PLUGIN_DATA} with the plugin data dir and auto-creates it', async () => {
    const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'xc-cmd-data-'))
    const prev = process.env.XC_PLUGINS_DIR
    process.env.XC_PLUGINS_DIR = tmpHome
    try {
      const out = expandCommandBody(cmd('cat ${CLAUDE_PLUGIN_DATA}/notes.md'), '')
      // The body still names the plugin, so the substitution yields a path
      // under our temp plugins root.
      expect(out.startsWith('cat ')).toBe(true)
      const dataPath = out.slice('cat '.length).replace(/\/notes\.md$/, '')
      const stat = await fs.stat(dataPath)
      expect(stat.isDirectory()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.XC_PLUGINS_DIR
      else process.env.XC_PLUGINS_DIR = prev
      await fs.rm(tmpHome, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('${CLAUDE_PLUGIN_DATA} stays empty when body has no plugin context to resolve', () => {
    // Synthesize a command def with no pluginId — should NOT mkdir or substitute.
    const c: import('../src/commands/types.js').CommandDefinition = {
      name: 't',
      body: 'echo ${CLAUDE_PLUGIN_DATA}/foo',
      source: 'plugin',
      pluginRoot: '/abs/p',
    }
    expect(expandCommandBody(c, '')).toBe('echo /foo')
  })
})

describe('CommandRegistry', () => {
  it('looks up by name and returns undefined for misses', () => {
    const reg = new CommandRegistry([
      { name: 'foo', body: 'b', source: 'plugin', pluginId: 'demo@local', pluginRoot: '/r' },
    ])
    expect(reg.get('foo')!.name).toBe('foo')
    expect(reg.get('bar')).toBeUndefined()
  })

  it('last-write-wins on name collision (mirrors SkillRegistry semantics)', () => {
    const reg = new CommandRegistry([
      { name: 'foo', body: 'first', source: 'plugin', pluginId: 'a@local', pluginRoot: '/a' },
      { name: 'foo', body: 'second', source: 'plugin', pluginId: 'b@local', pluginRoot: '/b' },
    ])
    expect(reg.get('foo')!.body).toBe('second')
    expect(reg.get('foo')!.pluginId).toBe('b@local')
  })
})
