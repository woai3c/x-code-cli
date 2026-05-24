// @x-code-cli/cli — Non-interactive plugin subcommands
//
// `xc plugin <subcommand> ...` entry point — runs without mounting the
// Ink UI, prints to stdout/stderr, exits with a status code suitable
// for scripts. Mirrors the slash-command family in `App.tsx`'s
// `handlePlugin` so users can drive the same operations from either
// surface.
//
// Routed from `index.ts`'s main() before yargs sees the args — that
// way `xc plugin install ./foo` doesn't get treated as a prompt the
// agent should answer.
import { Chalk } from 'chalk'

import {
  addKnownMarketplace,
  clearPluginEntry,
  fetchMarketplace,
  installPlugin,
  listInstalledPlugins,
  loadAllPlugins,
  lookupPlugin,
  readAllCachedMarketplaces,
  readKnownMarketplaces,
  removeKnownMarketplace,
  setPluginEnabled,
  uninstallPlugin,
} from '@x-code-cli/core'
import type { ConsentPreview, PluginScope, PluginSource } from '@x-code-cli/core'

const chalk = new Chalk()

export async function runPluginCli(args: string[]): Promise<number> {
  const sub = (args[0] ?? '').toLowerCase()
  const rest = args.slice(1)

  try {
    switch (sub) {
      case '':
      case 'list':
        return await cliList(rest)
      case 'info':
        return await cliInfo(rest)
      case 'install':
        return await cliInstall(rest)
      case 'uninstall':
        return await cliUninstall(rest)
      case 'enable':
        return await cliToggle(rest, true)
      case 'disable':
        return await cliToggle(rest, false)
      case 'search':
        return await cliSearch(rest)
      case 'update':
        return await cliUpdate(rest)
      case 'doctor':
        return await cliDoctor()
      case 'marketplace':
        return await cliMarketplace(rest)
      default:
        printUsage()
        return 1
    }
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)))
    return 1
  }
}

function printUsage(): void {
  console.error(
    [
      'Usage: xc plugin <subcommand> [args...]',
      '',
      'Subcommands:',
      '  list                      List installed plugins',
      "  info <id>                 Show a plugin's manifest, contributions, hooks",
      '  install <source>          Install from name@marketplace, github:owner/repo, git URL, or local path',
      '  uninstall <id>            Remove a plugin (cache + settings; data dir preserved)',
      '  enable <id>               Enable a plugin (global scope)',
      '  disable <id>              Disable a plugin without uninstalling',
      '  search <keyword>          Search subscribed marketplaces',
      '  update <id>               Reinstall from recorded source',
      '  doctor                    Show plugin load errors',
      '  marketplace <add|remove|list|refresh|info> [args...]',
      '                            Manage marketplace subscriptions',
      '',
      'Example:',
      '  xc plugin marketplace add anthropic-marketplace github:anthropics/marketplace',
      '  xc plugin marketplace refresh anthropic-marketplace',
      '  xc plugin install linear@anthropic-marketplace',
    ].join('\n'),
  )
}

function formatSource(s: PluginSource | undefined): string {
  if (!s) return '(unknown)'
  if (s.kind === 'local') return `local: ${s.path}`
  if (s.kind === 'git') return `git: ${s.url}${s.ref ? `#${s.ref}` : ''}`
  return `github:${s.owner}/${s.repo}${s.ref ? `#${s.ref}` : ''}`
}

// ── list / info ────────────────────────────────────────────────────────

async function cliList(args: string[] = []): Promise<number> {
  // Optional filters mirror the slash command: --enabled / --disabled.
  // No flag = list every installed plugin (default).
  let filter: 'all' | 'enabled' | 'disabled' = 'all'
  for (const a of args) {
    if (a === '--enabled') filter = 'enabled'
    else if (a === '--disabled') filter = 'disabled'
  }

  // For 'all' we can stay cheap and just read the bookkeeping file. For
  // filtered views we need the enabled state, which only loadAllPlugins
  // resolves (settings.json merge across scopes).
  if (filter === 'all') {
    const installed = await listInstalledPlugins()
    if (installed.length === 0) {
      console.log('No plugins installed.')
      return 0
    }
    console.log(`Installed plugins (${installed.length}):`)
    const namePad = Math.max(...installed.map((p) => p.id.length), 8) + 2
    for (const p of installed) {
      console.log(`  ${p.id.padEnd(namePad)} v${p.version}  ${formatSource(p.source)}`)
    }
    return 0
  }

  const load = await loadAllPlugins({ cwd: process.cwd() })
  const all = load.registry.listAll()
  const filtered = filter === 'enabled' ? all.filter((p) => p.enabled) : all.filter((p) => !p.enabled)
  if (all.length === 0) {
    console.log('No plugins installed.')
    return 0
  }
  if (filtered.length === 0) {
    console.log(`No ${filter} plugins.`)
    return 0
  }
  console.log(`Installed plugins (${filter}, ${filtered.length} of ${all.length}):`)
  const namePad = Math.max(...filtered.map((p) => p.id.length), 8) + 2
  for (const p of filtered) {
    const badge = p.enabled ? '[on] ' : '[off]'
    console.log(`  ${badge} ${p.id.padEnd(namePad)} v${p.manifest.version}  ${formatSource(p.source)}`)
  }
  return 0
}

async function cliInfo(args: string[]): Promise<number> {
  const id = args[0]
  if (!id) {
    console.error('Usage: xc plugin info <id>')
    return 1
  }
  // Use loadAllPlugins to get the actual manifest + enable state, not
  // just the bookkeeping record.
  const load = await loadAllPlugins({ cwd: process.cwd() })
  const plugin = load.registry.getEntry(id)
  if (!plugin) {
    console.error(`No plugin '${id}' loaded.`)
    return 1
  }
  console.log(`${plugin.id} v${plugin.manifest.version}`)
  if (plugin.manifest.description) console.log(plugin.manifest.description)
  console.log()
  console.log(`Enabled:     ${plugin.enabled ? 'yes' : 'no'}`)
  console.log(`Source:      ${formatSource(plugin.source)}`)
  console.log(`Marketplace: ${plugin.marketplace}`)
  console.log(`Root dir:    ${plugin.rootDir}`)
  console.log(`Manifest:    ${plugin.manifestPath} (${plugin.manifestFormat})`)
  const c = load.contributions.get(plugin.id)
  if (c) {
    console.log()
    console.log('Contributions:')
    if (c.skillsDir) console.log(`  skills:     ${c.skillsDir}`)
    if (c.agentsDir) console.log(`  agents:     ${c.agentsDir}`)
    if (c.commandsDir) console.log(`  commands:   ${c.commandsDir}`)
    if (c.mcpServers) console.log(`  mcpServers: ${c.mcpServers.kind === 'inline' ? '(inline)' : c.mcpServers.path}`)
    if (c.hooks) console.log(`  hooks:      ${c.hooks.kind === 'inline' ? '(inline)' : c.hooks.path}`)
  }
  return 0
}

// ── install / uninstall / update ───────────────────────────────────────

async function cliInstall(args: string[]): Promise<number> {
  // Strip --yes / -y from args before reading the source. Order-
  // independent so users can write either `--yes <src>` or
  // `<src> --yes`.
  const skipConsent = args.includes('--yes') || args.includes('-y')
  const sourceArgs = args.filter((a) => a !== '--yes' && a !== '-y')
  const raw = sourceArgs.join(' ').trim()
  if (!raw) {
    console.error('Usage: xc plugin install [--yes] <source>')
    console.error('  <source>: name@marketplace | github:owner/repo | https://... | /path')
    return 1
  }

  const parsed = await parseInstallSource(raw)
  if (!parsed) return 1

  console.log(`Installing from ${formatSource(parsed.source)} ...`)
  try {
    const result = await installPlugin({
      source: parsed.source,
      marketplace: parsed.marketplace,
      expectedName: parsed.expectedName,
      consent: skipConsent ? undefined : promptConsent,
      // userConfig prompt only runs when manifest declares fields AND
      // not in `--yes` non-interactive mode (scripts can pre-seed
      // values by editing ~/.x-code/plugins/user-config.json directly
      // or by writing them via the future `xc plugin configure` cmd).
      userConfigPrompt: skipConsent ? undefined : promptUserConfig,
    })
    console.log(chalk.green(`Installed ${result.pluginId} v${result.manifest.version}`))
    console.log(`Cache: ${result.rootDir}`)
    console.log("Restart xc to load this plugin's contributions.")
    return 0
  } catch (err) {
    console.error(chalk.red(`Install failed: ${err instanceof Error ? err.message : String(err)}`))
    return 1
  }
}

/** Render the consent preview to stderr and read a y/n from stdin.
 *  Defaults to NO when run without a TTY (CI environments, piped
 *  install scripts) — those callers should pass `--yes` explicitly. */
async function promptConsent(preview: ConsentPreview): Promise<boolean> {
  const lines: string[] = []
  lines.push('')
  lines.push(chalk.bold.yellow(`About to install: ${preview.pluginId} v${preview.version}`))
  if (preview.description) lines.push(`  ${preview.description}`)
  lines.push('')
  lines.push(`  Source:      ${formatSource(preview.source)}`)
  lines.push(
    `  Marketplace: ${preview.marketplace}${preview.fromReservedMarketplace ? ' [reserved/official]' : ''}${preview.verified ? ' [verified]' : ''}`,
  )
  if (preview.author) lines.push(`  Author:      ${preview.author}`)
  if (preview.license) lines.push(`  License:     ${preview.license}`)
  if (preview.homepage) lines.push(`  Homepage:    ${preview.homepage}`)
  lines.push('')
  lines.push('  Will contribute:')
  if (preview.hasSkillsDir) lines.push('    - skills (added to /skill list)')
  if (preview.hasAgentsDir) lines.push('    - sub-agents (callable via the `task` tool)')
  if (preview.hasCommandsDir) lines.push('    - slash commands (declared but not yet wired — no file-based loader)')
  if (preview.inlineMcpServerNames.length > 0) {
    lines.push(
      `    - ${chalk.red('MCP servers')} (will be spawned as subprocesses): ${preview.inlineMcpServerNames.join(', ')}`,
    )
  } else if (preview.hasPathMcpServers) {
    lines.push(`    - ${chalk.red('MCP servers')} (from external file — spawned as subprocesses)`)
  }
  if (preview.hookEvents.length > 0) {
    lines.push(`    - ${chalk.red('Lifecycle hooks')} (will run shell commands on: ${preview.hookEvents.join(', ')})`)
  } else if (preview.hasPathHooks) {
    lines.push(`    - ${chalk.red('Lifecycle hooks')} (from external file — will run shell commands)`)
  }
  if (
    !preview.hasSkillsDir &&
    !preview.hasAgentsDir &&
    !preview.hasCommandsDir &&
    preview.inlineMcpServerNames.length === 0 &&
    !preview.hasPathMcpServers &&
    preview.hookEvents.length === 0 &&
    !preview.hasPathHooks
  ) {
    lines.push('    (no contributions declared)')
  }
  lines.push('')

  process.stderr.write(lines.join('\n'))

  // No TTY → default deny. Scripts should pass `--yes`.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(chalk.yellow('No TTY — declining install. Use --yes to skip the prompt in scripts.\n'))
    return false
  }

  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question('Proceed with install? [y/N] ')
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/** Walk the manifest's userConfig list and prompt for each field. Mirrors
 *  the consent prompt's TTY-only stance: scripts piping into install
 *  should pre-seed values or use `--yes` (which skips this entirely).
 *  Sensitive fields are NOT echoed during typing — we toggle the tty
 *  to raw mode for the duration of the question, mirroring how `git`
 *  prompts for credentials. */
async function promptUserConfig(
  fields: Parameters<NonNullable<Parameters<typeof installPlugin>[0]['userConfigPrompt']>>[0],
): Promise<Record<string, string | number | boolean> | null> {
  // installer only calls us when fields.length > 0, but TypeScript can't
  // see that from the call site — guard explicitly.
  if (!fields) return {}
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      chalk.yellow(
        'No TTY — skipping userConfig prompt. Pre-seed values in ~/.x-code/plugins/user-config.json or use --yes.\n',
      ),
    )
    return {}
  }
  process.stderr.write('\n' + chalk.bold('This plugin needs configuration:') + '\n')

  const collected: Record<string, string | number | boolean> = {}
  const readline = await import('node:readline/promises')
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
  try {
    for (const f of fields) {
      const label = f.prompt ?? f.description ?? f.key
      const required = f.required ? ' (required)' : ''
      const defaultNote = f.default !== undefined ? ` [default: ${f.default}]` : ''
      const sensitive = f.sensitive === true
      const promptText = `  ${chalk.cyan(f.key)}: ${label}${required}${defaultNote}\n  > `

      let answer: string
      if (sensitive) {
        // Suppress local echo for the duration of the read. Node's readline
        // doesn't expose this directly, so we monkey-patch the output stream's
        // write to drop everything except a one-off '*' per keystroke. Same
        // technique inquirer uses for its `password` prompt.
        const out = process.stderr
        const originalWrite = out.write.bind(out)
        process.stderr.write(promptText)
        let muted = true
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(out as { write: (...args: any[]) => boolean }).write = (chunk: string | Buffer) => {
          if (!muted) return originalWrite(chunk)
          const s = typeof chunk === 'string' ? chunk : chunk.toString()
          if (s.includes('\n') || s.includes('\r')) return originalWrite(s)
          return true
        }
        try {
          answer = await rl.question('')
        } finally {
          muted = false
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(out as { write: (...args: any[]) => boolean }).write = originalWrite
          process.stderr.write('\n')
        }
      } else {
        answer = await rl.question(promptText)
      }

      const trimmed = answer.trim()
      if (!trimmed) {
        if (f.default !== undefined) {
          collected[f.key] = f.default
        } else if (f.required) {
          process.stderr.write(chalk.red(`  '${f.key}' is required.\n`))
          return null
        }
        continue
      }

      if (f.type === 'number') {
        const n = Number(trimmed)
        if (!Number.isFinite(n)) {
          process.stderr.write(chalk.red(`  '${f.key}' must be a number.\n`))
          return null
        }
        collected[f.key] = n
      } else if (f.type === 'boolean') {
        collected[f.key] = /^(true|y|yes|1)$/i.test(trimmed)
      } else {
        collected[f.key] = trimmed
      }
    }
  } finally {
    rl.close()
  }
  return collected
}

async function parseInstallSource(
  raw: string,
): Promise<{ source: PluginSource; marketplace: string; expectedName?: string } | null> {
  const isPath = raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(raw)
  const isGitUrl = /^https?:\/\//i.test(raw) || raw.startsWith('git@')
  const isGhShort = raw.startsWith('github:')
  const atIdx = raw.lastIndexOf('@')
  const isMarketplaceRef = atIdx > 0 && !isPath && !isGitUrl && !isGhShort

  if (isMarketplaceRef) {
    const name = raw.slice(0, atIdx)
    const mpName = raw.slice(atIdx + 1)
    const found = await lookupPlugin(`${name}@${mpName}`)
    if (!found) {
      console.error(
        `Plugin '${name}' not found in marketplace '${mpName}'. ` +
          `Run 'xc plugin marketplace refresh ${mpName}' or check the spelling.`,
      )
      return null
    }
    return { source: found.entry.source, marketplace: mpName, expectedName: name }
  }
  if (isGhShort) {
    const m = raw.match(/^github:([^/]+)\/(.+?)(?:#(.+))?$/i)
    if (!m) {
      console.error('Invalid github source. Expected github:owner/repo[#ref]')
      return null
    }
    return { source: { kind: 'github', owner: m[1]!, repo: m[2]!, ref: m[3] }, marketplace: 'local' }
  }
  if (isGitUrl) {
    return { source: { kind: 'git', url: raw }, marketplace: 'local' }
  }
  if (isPath) {
    return { source: { kind: 'local', path: raw }, marketplace: 'local' }
  }
  console.error(`Unrecognised source: '${raw}'. Use name@marketplace, github:owner/repo, an https/git URL, or a path.`)
  return null
}

async function cliUninstall(args: string[]): Promise<number> {
  const id = args[0]
  if (!id) {
    console.error('Usage: xc plugin uninstall <id>')
    return 1
  }
  const result = await uninstallPlugin(id)
  if (!result.removedRecord && result.removedVersions.length === 0) {
    console.error(`No plugin '${id}' installed.`)
    return 1
  }
  for (const scope of ['user', 'project'] as PluginScope[]) {
    await clearPluginEntry(id, scope).catch(() => undefined)
  }
  console.log(
    chalk.green(
      `Uninstalled ${id} (removed ${result.removedVersions.length} cached version${result.removedVersions.length === 1 ? '' : 's'})`,
    ),
  )
  console.log('Data dir preserved. Restart xc to drop contributions from active registries.')
  return 0
}

async function cliToggle(args: string[], enable: boolean): Promise<number> {
  // Pull out the optional --scope flag before the positional id, matching
  // the shape of /skill enable|disable. Default scope = 'user'.
  let scope: PluginScope = 'user'
  const positional: string[] = []
  for (const a of args) {
    const m = a.match(/^(?:--scope|-s)(?:=(.+))?$/)
    if (m) {
      const v = m[1]?.toLowerCase()
      if (v === 'user' || v === 'project') scope = v
      continue
    }
    positional.push(a)
  }
  const id = positional[0]
  if (!id) {
    console.error(`Usage: xc plugin ${enable ? 'enable' : 'disable'} <id> [--scope=user|project]`)
    return 1
  }
  const result = await setPluginEnabled(id, scope, enable)
  const verb = enable ? 'enabled' : 'disabled'
  if (result === 'noop') {
    console.log(`Plugin '${id}' already ${verb} (${scope} scope).`)
  } else {
    console.log(chalk.green(`Plugin ${id} ${verb} in ${scope} scope.`))
    console.log('Restart xc to apply (contributions are bound at startup).')
  }
  return 0
}

async function cliUpdate(args: string[]): Promise<number> {
  const id = args[0]
  if (!id) {
    console.error('Usage: xc plugin update <id>')
    return 1
  }
  const records = await listInstalledPlugins()
  const rec = records.find((r) => r.id === id)
  if (!rec) {
    console.error(`Plugin '${id}' not installed.`)
    return 1
  }
  console.log(`Reinstalling ${id} from ${formatSource(rec.source)} ...`)
  try {
    const result = await installPlugin({
      source: rec.source,
      marketplace: rec.marketplace,
      expectedName: rec.name,
    })
    if (result.manifest.version === rec.version) {
      console.log(`Reinstalled at the same version (${rec.version}).`)
    } else {
      console.log(chalk.green(`Updated ${rec.version} → ${result.manifest.version}`))
    }
    return 0
  } catch (err) {
    console.error(chalk.red(`Update failed: ${err instanceof Error ? err.message : String(err)}`))
    return 1
  }
}

// ── search / doctor ────────────────────────────────────────────────────

async function cliSearch(args: string[]): Promise<number> {
  const kw = args.join(' ').trim().toLowerCase()
  if (!kw) {
    console.error('Usage: xc plugin search <keyword>')
    return 1
  }
  const marketplaces = await readAllCachedMarketplaces()
  if (marketplaces.length === 0) {
    console.error('No subscribed marketplaces. Add one with `xc plugin marketplace add`.')
    return 1
  }
  const matches: Array<{ marketplace: string; name: string; description?: string; verified?: boolean }> = []
  for (const m of marketplaces) {
    for (const entry of m.plugins) {
      const hay = [entry.name, entry.description ?? '', ...(entry.keywords ?? [])].join(' ').toLowerCase()
      if (hay.includes(kw)) {
        matches.push({
          marketplace: m.name,
          name: entry.name,
          description: entry.description,
          verified: entry.verified,
        })
      }
    }
  }
  if (matches.length === 0) {
    console.log(`No plugins matching '${kw}'.`)
    return 0
  }
  console.log(`Found ${matches.length} match${matches.length === 1 ? '' : 'es'}:`)
  for (const m of matches) {
    const tag = m.verified ? ' [verified]' : ''
    console.log(`  ${m.name}@${m.marketplace}${tag}`)
    if (m.description) console.log(`    ${m.description}`)
  }
  return 0
}

async function cliDoctor(): Promise<number> {
  const load = await loadAllPlugins({ cwd: process.cwd() })
  const all = load.registry.listAll()
  const errors = load.registry.loadErrors()
  console.log('Plugin doctor')
  console.log()
  console.log(`  Total loaded: ${all.length}`)
  console.log(`  Enabled:      ${all.filter((p) => p.enabled).length}`)
  console.log(`  Disabled:     ${all.filter((p) => !p.enabled).length}`)
  console.log(`  Load errors:  ${errors.length}`)
  if (errors.length > 0) {
    console.log()
    console.log('Errors:')
    for (const e of errors) {
      console.log(`  - ${e.id ?? '(unknown)'} at ${e.path}`)
      console.log(`    ${e.message}`)
    }
  }
  console.log()
  console.log('For deeper diagnostics, set DEBUG_STDOUT=1 and check ~/.x-code/logs/debug.log')
  return errors.length > 0 ? 1 : 0
}

// ── marketplace ─────────────────────────────────────────────────────────

async function cliMarketplace(args: string[]): Promise<number> {
  const sub = (args[0] ?? '').toLowerCase()
  const rest = args.slice(1)

  if (sub === '' || sub === 'list') {
    const km = await readKnownMarketplaces()
    if (km.marketplaces.length === 0) {
      console.log('No marketplaces subscribed.')
      return 0
    }
    console.log(`Subscribed marketplaces (${km.marketplaces.length}):`)
    const namePad = Math.max(...km.marketplaces.map((m) => m.name.length), 8) + 2
    for (const m of km.marketplaces) {
      const tag = m.reservedName ? ' [official]' : ''
      console.log(`  ${m.name.padEnd(namePad)} ${m.source}${tag}`)
    }
    return 0
  }
  if (sub === 'add') {
    const name = rest[0]
    const source = rest.slice(1).join(' ')
    if (!name || !source) {
      console.error('Usage: xc plugin marketplace add <name> <source>')
      return 1
    }
    try {
      await addKnownMarketplace({ name, source })
      console.log(chalk.green(`Subscribed to ${name} (${source})`))
      console.log(`Run 'xc plugin marketplace refresh ${name}' to fetch its index.`)
      return 0
    } catch (err) {
      console.error(chalk.red(err instanceof Error ? err.message : String(err)))
      return 1
    }
  }
  if (sub === 'remove') {
    const name = rest[0]
    if (!name) {
      console.error('Usage: xc plugin marketplace remove <name>')
      return 1
    }
    const result = await removeKnownMarketplace(name)
    if (result === 'noop') {
      console.error(`No marketplace '${name}' subscribed.`)
      return 1
    }
    console.log(chalk.green(`Unsubscribed from ${name}.`))
    return 0
  }
  if (sub === 'refresh') {
    const km = await readKnownMarketplaces()
    const wanted = rest[0]
    const targets = wanted ? km.marketplaces.filter((m) => m.name === wanted) : km.marketplaces
    if (targets.length === 0) {
      console.error(wanted ? `No marketplace '${wanted}' subscribed.` : 'No marketplaces subscribed.')
      return 1
    }
    let hadError = false
    for (const t of targets) {
      try {
        const m = await fetchMarketplace(t)
        console.log(chalk.green(`✓ ${t.name} — ${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}`))
      } catch (err) {
        hadError = true
        console.error(chalk.red(`✗ ${t.name} — ${err instanceof Error ? err.message : String(err)}`))
      }
    }
    return hadError ? 1 : 0
  }
  if (sub === 'info') {
    const name = rest[0]
    if (!name) {
      console.error('Usage: xc plugin marketplace info <name>')
      return 1
    }
    const all = await readAllCachedMarketplaces()
    const m = all.find((x) => x.name === name)
    if (!m) {
      console.error(`No cached index for '${name}'. Run 'xc plugin marketplace refresh ${name}' first.`)
      return 1
    }
    console.log(`${m.displayName ?? m.name} (${m.name})`)
    if (m.description) console.log(m.description)
    if (m.owner?.name) console.log(`Owner: ${m.owner.name}${m.owner.url ? ` (${m.owner.url})` : ''}`)
    console.log()
    console.log(`${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}:`)
    for (const p of m.plugins) {
      const ver = p.verified ? ' [verified]' : ''
      const cat = p.category ? ` (${p.category})` : ''
      console.log(`  ${p.name}${ver}${cat}`)
      if (p.description) console.log(`    ${p.description}`)
    }
    return 0
  }
  console.error('Usage: xc plugin marketplace <list|add|remove|refresh|info> [args...]')
  return 1
}
