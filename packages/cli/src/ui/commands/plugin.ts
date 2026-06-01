// @x-code-cli/cli — /plugin slash command handler family.
//
// Extracted from App.tsx as a single factory that closes over the deps the
// plugin subcommands need: the four sub-registries (plugin / skill / sub-
// agent / command), the MCP registry (for restart-in-same-pass refresh),
// the hook bus, the prompt-cache invalidator, and the skill-registry
// version bumper (so /help and tab completion recompute).
//
// Subcommands: list / info / install / uninstall / enable / disable /
// search / update / refresh / doctor / marketplace (with its own
// add / remove / list / refresh / info sub-tree). Unknown sub prints
// the usage hint.
import {
  addKnownMarketplace,
  clearPluginEntry,
  fetchMarketplace,
  installPlugin,
  listInstalledPlugins,
  lookupPlugin,
  readAllCachedMarketplaces,
  readKnownMarketplaces,
  refreshPluginContributions,
  removeKnownMarketplace,
  resolveContributions,
  setPluginEnabled,
  uninstallPlugin,
} from '@x-code-cli/core'
import type { AgentOptions, PluginScope, PluginSource } from '@x-code-cli/core'

export interface PluginCommandDeps {
  options: AgentOptions
  addCommandMessage: (text: string, content: string) => void
  askQuestion: (
    question: string,
    options: { label: string; description: string }[],
    opts?: { noOther?: boolean },
  ) => Promise<string>
  invalidateSystemPromptCache: () => void
  bumpSkillRegistryVersion: () => void
}

function formatPluginSource(s: PluginSource | undefined): string {
  if (!s) return '(unknown)'
  if (s.kind === 'local') return `local: ${s.path}`
  if (s.kind === 'git') return `git: ${s.url}${s.ref ? `#${s.ref}` : ''}`
  return `github:${s.owner}/${s.repo}${s.ref ? `#${s.ref}` : ''}`
}

/** Parse a `/plugin enable|disable` argument string, recognizing the
 *  shared `--scope=user|project` / `-s=user|project` flag (same parser
 *  shape as parseSkillScopeFlag). Default scope = 'user' so terse
 *  invocations stay terse. */
function parsePluginScopeFlag(arg: string): { id: string; scope: PluginScope } {
  const tokens = arg.split(/\s+/).filter(Boolean)
  let scope: PluginScope = 'user'
  const remaining: string[] = []
  for (const tok of tokens) {
    const m = tok.match(/^(?:--scope|-s)(?:=(.+))?$/)
    if (m) {
      const value = m[1]?.toLowerCase()
      if (value === 'user' || value === 'project') scope = value
      continue
    }
    remaining.push(tok)
  }
  return { id: remaining.join(' '), scope }
}

export function createPluginCommandHandler(deps: PluginCommandDeps) {
  const { options, addCommandMessage, askQuestion, invalidateSystemPromptCache, bumpSkillRegistryVersion } = deps

  function pluginList(text: string, raw: string): void {
    const reg = options.pluginRegistry
    if (!reg) {
      addCommandMessage(text, 'Plugin system is disabled for this session (`--no-plugins`).')
      return
    }
    // Optional filters: --enabled (only on), --disabled (only off), no flag = all.
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    let filter: 'all' | 'enabled' | 'disabled' = 'all'
    for (const t of tokens) {
      // Skip the subcommand word itself ('list') if present
      if (t === 'list') continue
      if (t === '--enabled') filter = 'enabled'
      else if (t === '--disabled') filter = 'disabled'
    }
    const all = reg.listAll()
    if (all.length === 0) {
      addCommandMessage(text, 'No plugins installed. Install one with `/plugin install <source>`.')
      return
    }
    const filtered =
      filter === 'enabled' ? all.filter((p) => p.enabled) : filter === 'disabled' ? all.filter((p) => !p.enabled) : all
    if (filtered.length === 0) {
      addCommandMessage(text, `No ${filter} plugins.`)
      return
    }
    const header =
      filter === 'all'
        ? `**Installed plugins** (${filtered.length}):`
        : `**Installed plugins** (${filter}, ${filtered.length} of ${all.length}):`
    const lines = [header]
    const namePad = Math.max(...filtered.map((p) => p.id.length), 8) + 2
    for (const p of filtered) {
      const badge = p.enabled ? '[on] ' : '[off]'
      const src = p.marketplace === 'local' ? '(local)' : `(${p.marketplace})`
      lines.push(`  ${badge} ${p.id.padEnd(namePad)} v${p.manifest.version}  ${src}`)
    }
    const errors = reg.loadErrors()
    if (errors.length > 0) {
      lines.push('', `${errors.length} load error${errors.length === 1 ? '' : 's'} — run \`/plugin doctor\`.`)
    }
    addCommandMessage(text, lines.join('\n'))
  }

  async function pluginInfo(text: string, raw: string): Promise<void> {
    const id = raw.trim()
    if (!id) {
      addCommandMessage(text, 'Usage: `/plugin info <id>`  (id = `name@marketplace`)')
      return
    }
    const plugin = options.pluginRegistry?.getEntry(id)
    if (!plugin) {
      addCommandMessage(text, `No plugin \`${id}\` loaded. Check \`/plugin list\`.`)
      return
    }
    const c = await resolveContributions(plugin)
    const lines: string[] = [
      `**${plugin.id}** v${plugin.manifest.version}`,
      plugin.manifest.description ?? '_(no description)_',
      '',
      `- Enabled:     ${plugin.enabled ? 'yes' : 'no'}`,
      `- Source:      ${formatPluginSource(plugin.source)}`,
      `- Marketplace: ${plugin.marketplace}`,
      `- Root dir:    ${plugin.rootDir}`,
      `- Manifest:    ${plugin.manifestPath} (${plugin.manifestFormat})`,
    ]
    if (plugin.manifest.author?.name) lines.push(`- Author:      ${plugin.manifest.author.name}`)
    if (plugin.manifest.homepage) lines.push(`- Homepage:    ${plugin.manifest.homepage}`)
    if (plugin.manifest.license) lines.push(`- License:     ${plugin.manifest.license}`)

    lines.push('', '**Contributions:**')
    let any = false
    if (c.skillsDir) {
      lines.push(`- skills:     ${c.skillsDir}`)
      any = true
    }
    if (c.agentsDir) {
      lines.push(`- agents:     ${c.agentsDir}`)
      any = true
    }
    if (c.commandsDir) {
      lines.push(`- commands:   ${c.commandsDir}`)
      any = true
    }
    if (c.mcpServers) {
      lines.push(`- mcpServers: ${c.mcpServers.kind === 'inline' ? '(inline)' : c.mcpServers.path}`)
      any = true
    }
    if (c.hooks) {
      lines.push(`- hooks:      ${c.hooks.kind === 'inline' ? '(inline)' : c.hooks.path}`)
      any = true
    }
    if (!any) lines.push('- _(none)_')

    addCommandMessage(text, lines.join('\n'))
  }

  async function pluginInstall(text: string, raw: string): Promise<void> {
    if (!raw) {
      addCommandMessage(
        text,
        'Usage: `/plugin install <source>`\n' +
          '  Sources:\n' +
          '    `<name>@<marketplace>` — look up + install from subscribed marketplace\n' +
          '    `github:owner/repo[#ref]` — install from a GitHub repo\n' +
          '    `https://...` or `git@...` — install from any git URL\n' +
          '    `/abs/path` or `./relative/path` — install from a local directory',
      )
      return
    }

    const tokens = raw.trim().split(/\s+/)
    const source_str = tokens[0]!
    const extras = tokens.slice(1).filter((t) => t !== '--yes' && t !== '-y')
    if (extras.length > 0) {
      addCommandMessage(
        text,
        `Unrecognised arguments to \`/plugin install\`: ${extras.map((e) => `\`${e}\``).join(', ')}`,
      )
      return
    }
    raw = source_str

    let source: PluginSource
    let marketplace: string
    let expectedName: string | undefined

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
        addCommandMessage(
          text,
          `Plugin \`${name}\` not found in marketplace \`${mpName}\`. ` +
            `Run \`/plugin marketplace refresh ${mpName}\` or check the spelling.`,
        )
        return
      }
      source = found.entry.source
      marketplace = mpName
      expectedName = name
    } else if (isGhShort) {
      const m = raw.match(/^github:([^/]+)\/(.+?)(?:#(.+))?$/i)
      if (!m) {
        addCommandMessage(text, 'Invalid github source. Expected `github:owner/repo` or `github:owner/repo#ref`.')
        return
      }
      source = { kind: 'github', owner: m[1]!, repo: m[2]!, ref: m[3] }
      marketplace = 'local'
    } else if (isGitUrl) {
      source = { kind: 'git', url: raw }
      marketplace = 'local'
    } else if (isPath) {
      source = { kind: 'local', path: raw }
      marketplace = 'local'
    } else {
      addCommandMessage(
        text,
        `Unrecognised source: \`${raw}\`. Use \`name@marketplace\`, \`github:owner/repo\`, an https/git URL, or a path.`,
      )
      return
    }

    addCommandMessage(text, `Installing from ${formatPluginSource(source)} …`)
    try {
      const result = await installPlugin({ source, marketplace, expectedName })
      addCommandMessage(
        text,
        `Installed **${result.pluginId}** v${result.manifest.version}\n` +
          `Cache: \`${result.rootDir}\`\n` +
          `Run \`/plugin refresh\` to load this plugin's contributions now (skills / agents / commands / hooks). ` +
          `MCP servers need \`/mcp refresh\` separately.`,
      )
    } catch (err) {
      addCommandMessage(text, `Install failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function pluginUninstall(text: string, raw: string): Promise<void> {
    const id = raw.trim()
    if (!id) {
      addCommandMessage(text, 'Usage: `/plugin uninstall <id>` (id = `name@marketplace`)')
      return
    }
    try {
      const result = await uninstallPlugin(id)
      if (!result.removedRecord && result.removedVersions.length === 0) {
        addCommandMessage(text, `No plugin \`${id}\` installed.`)
        return
      }
      for (const scope of ['user', 'project'] as PluginScope[]) {
        await clearPluginEntry(id, scope).catch(() => undefined)
      }
      const verCount = result.removedVersions.length
      addCommandMessage(
        text,
        `Uninstalled **${id}** (removed ${verCount} cached version${verCount === 1 ? '' : 's'}).\n` +
          `Plugin data dir preserved — reinstall will keep user state.\n` +
          `Run \`/plugin refresh\` to drop its contributions from active registries.`,
      )
    } catch (err) {
      addCommandMessage(text, `Uninstall failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function pluginToggle(text: string, raw: string, enable: boolean): Promise<void> {
    const { id, scope } = parsePluginScopeFlag(raw)
    if (!id) {
      addCommandMessage(text, `Usage: \`/plugin ${enable ? 'enable' : 'disable'} <id> [--scope=user|project]\``)
      return
    }
    try {
      const result = await setPluginEnabled(id, scope, enable)
      const verb = enable ? 'enabled' : 'disabled'
      if (result === 'noop') {
        addCommandMessage(text, `Plugin \`${id}\` already ${verb} (${scope} scope).`)
      } else {
        addCommandMessage(text, `Plugin **${id}** ${verb} in ${scope} scope. Run \`/plugin refresh\` to apply now.`)
      }
    } catch (err) {
      addCommandMessage(text, `Failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function pluginSearch(text: string, raw: string): Promise<void> {
    const kw = raw.trim().toLowerCase()
    if (!kw) {
      addCommandMessage(text, 'Usage: `/plugin search <keyword>`')
      return
    }
    const marketplaces = await readAllCachedMarketplaces()
    if (marketplaces.length === 0) {
      const km = await readKnownMarketplaces()
      if (km.marketplaces.length === 0) {
        addCommandMessage(
          text,
          'No subscribed marketplaces. Add one with `/plugin marketplace add <name> <source>` and `refresh` it.',
        )
      } else {
        const names = km.marketplaces.map((m) => m.name).join(', ')
        addCommandMessage(
          text,
          `No cached marketplace index. You're subscribed to ${names} but the cache is empty — run \`/plugin marketplace refresh\` to fetch.`,
        )
      }
      return
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
      addCommandMessage(
        text,
        `No plugins matching \`${kw}\` in ${marketplaces.length} subscribed marketplace${marketplaces.length === 1 ? '' : 's'}. ` +
          `Run \`/plugin marketplace refresh\` to pull latest indexes.`,
      )
      return
    }
    const lines = [`Found ${matches.length} match${matches.length === 1 ? '' : 'es'}:`]
    for (const m of matches) {
      const tag = m.verified ? ' [verified]' : ''
      lines.push(`  ${m.name}@${m.marketplace}${tag}`)
      if (m.description) lines.push(`    ${m.description}`)
    }
    lines.push('', 'Install with `/plugin install <name>@<marketplace>`.')
    addCommandMessage(text, lines.join('\n'))
  }

  async function pluginUpdate(text: string, raw: string): Promise<void> {
    const tokens = raw.trim().split(/\s+/).filter(Boolean)
    const all = tokens.includes('--all') || tokens.includes('-a')
    const positional = tokens.filter((t) => t !== '--all' && t !== '-a')

    if (all && positional.length > 0) {
      addCommandMessage(text, '`/plugin update`: pass either `--all` or a plugin id, not both.')
      return
    }
    if (!all && positional.length === 0) {
      addCommandMessage(
        text,
        'Usage: `/plugin update <id>` · `/plugin update --all`\n' +
          '  `<id>`: a `name@marketplace` from `/plugin list`\n' +
          '  `--all`: update every installed plugin (sequential, skip-on-error)',
      )
      return
    }

    if (all) {
      const records = await listInstalledPlugins()
      if (records.length === 0) {
        addCommandMessage(text, 'No plugins installed.')
        return
      }
      addCommandMessage(text, `Updating ${records.length} plugin${records.length === 1 ? '' : 's'} …`)
      const lines: string[] = []
      let updated = 0
      let unchanged = 0
      let failed = 0
      for (const rec of records) {
        try {
          const result = await installPlugin({
            source: rec.source,
            marketplace: rec.marketplace,
            expectedName: rec.name,
          })
          if (result.manifest.version === rec.version) {
            lines.push(`  ${rec.id}: reinstalled at ${rec.version}`)
            unchanged++
          } else {
            lines.push(`  ${rec.id}: ${rec.version} → ${result.manifest.version}`)
            updated++
          }
        } catch (err) {
          lines.push(`  ${rec.id}: failed — ${err instanceof Error ? err.message : String(err)}`)
          failed++
        }
      }
      lines.push('', `Summary: ${updated} updated, ${unchanged} unchanged, ${failed} failed.`)
      if (updated > 0) lines.push('Run `/plugin refresh` to load the new versions.')
      addCommandMessage(text, lines.join('\n'))
      return
    }

    const id = positional[0]!
    const records = await listInstalledPlugins()
    const rec = records.find((r) => r.id === id)
    if (!rec) {
      addCommandMessage(text, `Plugin \`${id}\` not installed.`)
      return
    }
    addCommandMessage(text, `Reinstalling **${id}** from ${formatPluginSource(rec.source)} …`)
    try {
      const result = await installPlugin({
        source: rec.source,
        marketplace: rec.marketplace,
        expectedName: rec.name,
      })
      const versionMsg =
        result.manifest.version === rec.version
          ? `Reinstalled at the same version (${rec.version}).`
          : `Updated ${rec.version} → ${result.manifest.version}.`
      addCommandMessage(text, `${versionMsg} Run \`/plugin refresh\` to load the new version.`)
    } catch (err) {
      addCommandMessage(text, `Update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async function pluginRefresh(text: string): Promise<void> {
    if (!options.pluginRegistry) {
      addCommandMessage(text, 'Plugin system is disabled for this session (`--no-plugins`).')
      return
    }
    let summary
    try {
      summary = await refreshPluginContributions({
        pluginRegistry: options.pluginRegistry,
        skillRegistry: options.skillRegistry,
        subAgentRegistry: options.subAgentRegistry,
        commandRegistry: options.commandRegistry,
        hookBus: options.hookBus,
        mcpRegistry: options.mcpRegistry,
        askUser: (q, opts) => askQuestion(q, opts, { noOther: true }),
        cwd: process.cwd(),
      })
    } catch (err) {
      addCommandMessage(text, `Failed to reload plugins: ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    invalidateSystemPromptCache()
    bumpSkillRegistryVersion()

    const parts: string[] = []
    const p = summary.plugins
    if (p.added.length) parts.push(`added: ${p.added.join(', ')}`)
    if (p.removed.length) parts.push(`removed: ${p.removed.join(', ')}`)
    if (p.changed.length) parts.push(`changed: ${p.changed.join(', ')}`)
    if (parts.length === 0) parts.push(`no plugin changes (${p.unchanged.length} unchanged)`)
    const lines = [`Reloaded plugins — ${parts.join('; ')}.`]
    const subBits: string[] = []
    if (summary.skills && (summary.skills.added.length || summary.skills.removed.length))
      subBits.push(`${summary.skills.added.length + summary.skills.removed.length} skill change(s)`)
    if (summary.subAgents && (summary.subAgents.added.length || summary.subAgents.removed.length))
      subBits.push(`${summary.subAgents.added.length + summary.subAgents.removed.length} sub-agent change(s)`)
    if (summary.commands && (summary.commands.added.length || summary.commands.removed.length))
      subBits.push(`${summary.commands.added.length + summary.commands.removed.length} command change(s)`)
    if (subBits.length) lines.push(`Downstream: ${subBits.join(', ')}.`)
    if (summary.mcp) {
      const m = summary.mcp
      const mcpBits: string[] = []
      if (m.added.length) mcpBits.push(`added: ${m.added.join(', ')}`)
      if (m.removed.length) mcpBits.push(`removed: ${m.removed.join(', ')}`)
      if (m.changed.length) mcpBits.push(`changed: ${m.changed.join(', ')}`)
      if (mcpBits.length) lines.push(`MCP — ${mcpBits.join('; ')}.`)
      else if (m.unchanged.length) lines.push(`MCP — ${m.unchanged.length} server(s) reconnected.`)
    }
    if (summary.mcpProjectSkipped) {
      lines.push('Note: project-level MCP servers were skipped (trust dialog declined).')
    }
    for (const e of summary.mcpConfigErrors ?? []) {
      lines.push(`MCP config error: ${e.name}: ${e.message}`)
    }
    lines.push('Note: next message rebuilds the system prompt, so prompt-cache will miss once.')
    addCommandMessage(text, lines.join('\n'))
  }

  function pluginDoctor(text: string): void {
    const reg = options.pluginRegistry
    if (!reg) {
      addCommandMessage(text, 'Plugin system is disabled for this session (`--no-plugins`).')
      return
    }
    const errors = reg.loadErrors()
    const all = reg.listAll()
    const lines: string[] = ['**Plugin doctor**']
    lines.push(`- Total loaded: ${all.length}`)
    lines.push(`- Enabled:      ${all.filter((p) => p.enabled).length}`)
    lines.push(`- Disabled:     ${all.filter((p) => !p.enabled).length}`)
    lines.push(`- Load errors:  ${errors.length}`)
    if (errors.length > 0) {
      lines.push('', '**Errors:**')
      for (const e of errors) {
        lines.push(`- ${e.id ?? '(unknown)'} at \`${e.path}\``)
        lines.push(`  ${e.message}`)
      }
    }
    lines.push(
      '',
      '_For deeper diagnostics (mcp collisions, hook errors, unsupported `commands` contributions), set `DEBUG_STDOUT=1` and check `~/.x-code/logs/debug.log`._',
    )
    addCommandMessage(text, lines.join('\n'))
  }

  async function handlePluginMarketplace(text: string, arg: string): Promise<void> {
    const parts = arg.trim().split(/\s+/)
    const sub = (parts[0] ?? '').toLowerCase()
    const rest = parts.slice(1).join(' ').trim()

    if (sub === '' || sub === 'list') {
      const km = await readKnownMarketplaces()
      if (km.marketplaces.length === 0) {
        addCommandMessage(text, 'No marketplaces subscribed. Add one with `/plugin marketplace add <name> <source>`.')
        return
      }
      const lines = [`**Subscribed marketplaces** (${km.marketplaces.length}):`]
      const namePad = Math.max(...km.marketplaces.map((m) => m.name.length), 8) + 2
      for (const m of km.marketplaces) {
        const tag = m.reservedName ? ' [official]' : ''
        lines.push(`  ${m.name.padEnd(namePad)} ${m.source}${tag}`)
      }
      addCommandMessage(text, lines.join('\n'))
      return
    }

    if (sub === 'add') {
      const argParts = rest.split(/\s+/)
      if (argParts.length < 2 || !argParts[0] || !argParts[1]) {
        addCommandMessage(
          text,
          'Usage: `/plugin marketplace add <name> <source>` (source: `github:owner/repo` or an https URL to a marketplace.json)',
        )
        return
      }
      const [name, ...sourceParts] = argParts
      const source = sourceParts.join(' ')
      try {
        await addKnownMarketplace({ name, source })
        addCommandMessage(
          text,
          `Subscribed to **${name}** (\`${source}\`). Run \`/plugin marketplace refresh ${name}\` to fetch its index.`,
        )
      } catch (err) {
        addCommandMessage(text, `Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      return
    }

    if (sub === 'remove') {
      if (!rest) {
        addCommandMessage(text, 'Usage: `/plugin marketplace remove <name>`')
        return
      }
      const result = await removeKnownMarketplace(rest)
      if (result === 'noop') addCommandMessage(text, `No marketplace \`${rest}\` subscribed.`)
      else addCommandMessage(text, `Unsubscribed from **${rest}**.`)
      return
    }

    if (sub === 'refresh') {
      const km = await readKnownMarketplaces()
      const targets = rest ? km.marketplaces.filter((m) => m.name === rest) : km.marketplaces
      if (targets.length === 0) {
        addCommandMessage(text, rest ? `No marketplace \`${rest}\` subscribed.` : 'No marketplaces subscribed.')
        return
      }
      const lines: string[] = [`Refreshing ${targets.length} marketplace${targets.length === 1 ? '' : 's'} …`]
      for (const t of targets) {
        try {
          const m = await fetchMarketplace(t)
          lines.push(`  ✓ ${t.name} — ${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}`)
        } catch (err) {
          lines.push(`  ✗ ${t.name} — ${err instanceof Error ? err.message : String(err)}`)
        }
      }
      addCommandMessage(text, lines.join('\n'))
      return
    }

    if (sub === 'info') {
      if (!rest) {
        addCommandMessage(text, 'Usage: `/plugin marketplace info <name>`')
        return
      }
      const all = await readAllCachedMarketplaces()
      const m = all.find((x) => x.name === rest)
      if (!m) {
        addCommandMessage(
          text,
          `No cached index for marketplace \`${rest}\`. Run \`/plugin marketplace refresh ${rest}\` first.`,
        )
        return
      }
      const lines: string[] = [`**${m.displayName ?? m.name}** (${m.name})`]
      if (m.upstreamName) lines.push(`Upstream name: ${m.upstreamName}`)
      if (m.description) lines.push(m.description)
      if (m.owner?.name) lines.push(`Owner: ${m.owner.name}${m.owner.url ? ` (${m.owner.url})` : ''}`)
      lines.push('', `${m.plugins.length} plugin${m.plugins.length === 1 ? '' : 's'}:`)
      for (const p of m.plugins) {
        const ver = p.verified ? ' [verified]' : ''
        const cat = p.category ? ` (${p.category})` : ''
        lines.push(`  ${p.name}${ver}${cat}`)
        if (p.description) lines.push(`    ${p.description}`)
      }
      addCommandMessage(text, lines.join('\n'))
      return
    }

    addCommandMessage(text, 'Usage: `/plugin marketplace <list|add|remove|refresh|info>`')
  }

  async function handlePlugin(text: string, arg: string): Promise<void> {
    const trimmed = arg.trim()
    const parts = trimmed.split(/\s+/)
    const sub = (parts[0] ?? '').toLowerCase()
    const rest = parts.slice(1).join(' ').trim()

    if (sub === 'marketplace') return handlePluginMarketplace(text, rest)
    if (sub === '' || sub === 'list') return pluginList(text, arg)
    if (sub === 'info') return pluginInfo(text, rest)
    if (sub === 'install') return pluginInstall(text, rest)
    if (sub === 'uninstall') return pluginUninstall(text, rest)
    if (sub === 'enable') return pluginToggle(text, rest, true)
    if (sub === 'disable') return pluginToggle(text, rest, false)
    if (sub === 'search') return pluginSearch(text, rest)
    if (sub === 'update') return pluginUpdate(text, rest)
    if (sub === 'refresh') return void pluginRefresh(text)
    if (sub === 'doctor') return pluginDoctor(text)

    addCommandMessage(
      text,
      'Usage: `/plugin <list|info|install|uninstall|enable|disable|search|update|refresh|doctor|marketplace>`',
    )
  }

  return { handlePlugin }
}
