// @x-code-cli/cli — /mcp slash command handler family.
//
// Extracted from App.tsx as a factory that closes over the registry,
// permission store, plugin registry (for refresh's plugin-mcp merging),
// prompt-cache invalidator, plus the four UI-side hooks (addCommandMessage,
// addCommandResult, askQuestion).
//
// Subcommands: list / tools / auth / logout / refresh / add / add-json /
// remove. Add/Remove use --scope=user|project; --scope project auto-trusts
// the project for next launch.
import {
  detectScope,
  getMcpConfigPath,
  getPluginMcpServersFromDisk,
  getTokenStorage,
  loadMergedConfigsFromDisk,
  parseAdd,
  parseAddJson,
  parseRemove,
  readServerConfig,
  removeServerFromConfig,
  serverExists,
  trustProject,
  writeServerToConfig,
} from '@x-code-cli/core'
import type { AgentOptions } from '@x-code-cli/core'

export interface McpCommandDeps {
  options: AgentOptions
  addCommandMessage: (text: string, content: string) => void
  addCommandResult: (content: string) => void
  askQuestion: (
    question: string,
    options: { label: string; description: string }[],
    opts?: { noOther?: boolean },
  ) => Promise<string>
  invalidateSystemPromptCache: () => void
}

export function createMcpCommandHandler(deps: McpCommandDeps) {
  const { options, addCommandMessage, addCommandResult, askQuestion, invalidateSystemPromptCache } = deps

  /** /mcp add — write a new server to user (default) or project config.
   *
   *  Doesn't auto-connect: tool surface changes mid-session would invalidate
   *  the prompt cache and force a miss on the next turn (OpenAI-compatible
   *  providers' prefix cache). User is told to `/mcp refresh` or restart
   *  when they're ready — matches the design doc's "explicit refresh"
   *  philosophy.
   *
   *  --scope project also auto-trusts the project (the user running the
   *  command IS the consent signal — no point making them confirm a
   *  trust dialog for their own command on next start). Collaborators
   *  who clone the repo still go through the dialog normally. */
  async function handleMcpAdd(text: string, subArgRaw: string): Promise<void> {
    const res = parseAdd(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name, scope, config } = res.command

    // Duplicate-check in the requested scope. We use serverExists rather
    // than detectScope here on purpose: cross-scope name reuse is allowed
    // (a user-scope and project-scope server can legitimately share a
    // name — e.g. a personal vs team-shared variant). Only same-scope
    // collisions block the add.
    if (await serverExists(name, scope, process.cwd())) {
      const existing = await readServerConfig(name, scope, process.cwd())
      const summary =
        existing && typeof existing === 'object'
          ? JSON.stringify(existing, null, 2)
              .split('\n')
              .map((l) => '  ' + l)
              .join('\n')
          : '(unreadable)'
      addCommandMessage(
        text,
        [
          `Server "${name}" already exists in ${scope} scope:`,
          summary,
          '',
          `Run /mcp remove --scope ${scope} ${name} first, or pick a different name.`,
        ].join('\n'),
      )
      return
    }

    let written: { path: string }
    try {
      written = await writeServerToConfig(name, config, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to add "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    // For project scope, auto-trust this path so the user doesn't bump
    // into their own consent dialog on next launch.
    let autoTrusted = false
    if (scope === 'project') {
      try {
        await trustProject(process.cwd())
        autoTrusted = true
      } catch {
        // Non-fatal — they'll just see the trust dialog next launch.
      }
    }

    const transport = 'url' in config ? 'http' : 'stdio'
    const lines = [`Added MCP server "${name}" (${transport}) to ${written.path}.`]
    if (autoTrusted) {
      lines.push('Auto-trusted this project for future launches.')
    }
    if (scope === 'project') {
      lines.push('Tip: commit `.x-code/config.json` to share with collaborators.')
    }
    lines.push('Run /mcp refresh to load it now, or restart xc.')
    addCommandMessage(text, lines.join('\n'))
  }

  /** /mcp add-json — same as /mcp add but takes a raw JSON object for the
   *  config body. The escape hatch for complex configs that don't fit
   *  command-line flags (nested env, multiple headers, custom cwd, etc.). */
  async function handleMcpAddJson(text: string, subArgRaw: string): Promise<void> {
    const res = parseAddJson(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name, scope, config } = res.command

    if (await serverExists(name, scope, process.cwd())) {
      addCommandMessage(
        text,
        `Server "${name}" already exists in ${scope} scope. Run /mcp remove --scope ${scope} ${name} first.`,
      )
      return
    }

    let written: { path: string }
    try {
      written = await writeServerToConfig(name, config, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to add "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }

    let autoTrusted = false
    if (scope === 'project') {
      try {
        await trustProject(process.cwd())
        autoTrusted = true
      } catch {
        // best-effort
      }
    }

    const lines = [`Added MCP server "${name}" to ${written.path}.`]
    if (autoTrusted) lines.push('Auto-trusted this project for future launches.')
    if (scope === 'project') lines.push('Tip: commit `.x-code/config.json` to share with collaborators.')
    lines.push('Run /mcp refresh to load it now, or restart xc.')
    addCommandMessage(text, lines.join('\n'))
  }

  /** /mcp remove — delete a server from config.json. Asks y/N before doing
   *  anything destructive (every other competitor skips this — we keep
   *  it because a typo can nuke a real entry and the cost of one extra
   *  keypress is near zero). Current session keeps running with whatever
   *  it had loaded — disconnecting mid-session has more downside (live
   *  tool calls get orphaned) than upside (the file change only matters
   *  at next launch / refresh). */
  async function handleMcpRemove(text: string, subArgRaw: string): Promise<void> {
    const res = parseRemove(subArgRaw)
    if (!res.ok) {
      addCommandMessage(text, res.error)
      return
    }
    const { name } = res.command
    let scope = res.command.scope

    if (!scope) {
      // Auto-detect. The ambiguous case (both scopes) forces an explicit
      // --scope so we don't silently delete the wrong one.
      const detected = await detectScope(name, process.cwd())
      switch (detected.kind) {
        case 'not-found':
          addCommandMessage(text, `Server "${name}" is not in user or project config — nothing to remove.`)
          return
        case 'both':
          addCommandMessage(text, `Server "${name}" exists at both scopes. Specify --scope user or --scope project.`)
          return
        case 'user':
        case 'project':
          scope = detected.kind
          break
      }
    } else {
      // Explicit scope: verify presence before bothering the user with a
      // confirmation dialog.
      if (!(await serverExists(name, scope, process.cwd()))) {
        addCommandMessage(
          text,
          `Server "${name}" is not in ${scope} scope (${getMcpConfigPath(scope, process.cwd())}) — nothing to remove.`,
        )
        return
      }
    }

    const confirmAnswer = await askQuestion(
      `Remove MCP server "${name}" from ${scope} scope?\n  (${getMcpConfigPath(scope, process.cwd())})`,
      [
        { label: 'Remove', description: 'Delete this server entry. Current session unchanged.' },
        { label: 'Cancel', description: 'Keep the config as-is.' },
      ],
      { noOther: true },
    )
    if (confirmAnswer !== 'Remove') {
      addCommandMessage(text, `Cancelled — "${name}" not removed.`)
      return
    }

    let result: { path: string; removed: boolean }
    try {
      result = await removeServerFromConfig(name, scope, process.cwd())
    } catch (err) {
      addCommandMessage(text, `Failed to remove "${name}": ${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!result.removed) {
      // Race: someone deleted the file or entry between detection and
      // remove. Idempotent path — just say so.
      addCommandMessage(text, `Server "${name}" was already gone from ${scope} scope.`)
      return
    }

    addCommandMessage(
      text,
      [
        `Removed "${name}" from ${scope} scope (${result.path}).`,
        'Current session unchanged — the running server (if any) keeps working until xc exits.',
        `Stored OAuth tokens (if any) kept — run /mcp logout ${name} to clear them too.`,
      ].join('\n'),
    )
  }

  async function handleMcp(text: string, arg: string): Promise<void> {
    const argTrimmed = arg.trim()
    const sub = (argTrimmed.split(/\s+/)[0] ?? '').toLowerCase()
    const subArg = argTrimmed.slice(sub.length).trim()
    const registry = options.mcpRegistry

    switch (sub) {
      case '':
      case 'list': {
        const statuses = registry?.serverStatus() ?? []
        if (statuses.length === 0) {
          addCommandMessage(text, 'No MCP servers configured. Add `mcpServers` to ~/.x-code/config.json then restart.')
          return
        }
        const lines = ['MCP servers:']
        const namePad = Math.max(...statuses.map((s) => s.name.length), 8) + 2
        for (const s of statuses) {
          let badge = ''
          switch (s.status.kind) {
            case 'connected':
              badge = `connected — ${s.status.toolCount} tool${s.status.toolCount === 1 ? '' : 's'}, ${s.status.resourceCount} resource${s.status.resourceCount === 1 ? '' : 's'}`
              break
            case 'disabled':
              badge = 'disabled'
              break
            case 'connecting':
              badge = 'connecting…'
              break
            case 'needs_auth':
              badge = `needs auth — run /mcp auth ${s.name} to log in`
              break
            case 'failed':
              badge = `failed — ${s.status.error}`
              break
          }
          lines.push(`  ${s.name.padEnd(namePad)} ${badge}`)
        }
        addCommandMessage(text, lines.join('\n'))
        return
      }
      case 'tools': {
        const all = registry?.list() ?? []
        const filtered = subArg ? all.filter((t) => t.serverName === subArg) : all
        if (filtered.length === 0) {
          addCommandMessage(text, subArg ? `No tools on server "${subArg}".` : 'No MCP tools available.')
          return
        }
        const lines = [subArg ? `MCP tools on ${subArg}:` : 'All MCP tools:']
        for (const t of filtered) {
          const desc = t.description ? ` — ${t.description.slice(0, 160).replace(/\s+/g, ' ').trim()}` : ''
          lines.push(`  ${t.callableName}${desc}`)
        }
        addCommandMessage(text, lines.join('\n'))
        return
      }
      case 'auth': {
        if (!subArg) {
          addCommandMessage(text, 'Usage: /mcp auth <server-name>')
          return
        }
        if (!registry) {
          addCommandMessage(text, 'No MCP servers configured. Add `mcpServers` to ~/.x-code/config.json first.')
          return
        }
        const config = registry.getConfig(subArg)
        if (!config) {
          addCommandMessage(text, `Unknown MCP server: "${subArg}". Run /mcp list to see configured servers.`)
          return
        }
        if (!('url' in config) || typeof config.url !== 'string') {
          addCommandMessage(
            text,
            `MCP server "${subArg}" is a stdio server — OAuth applies to HTTP servers (those with a "url" field) only.`,
          )
          return
        }
        // Drop stored tokens up front. If the user runs /mcp auth on a
        // server with valid tokens, we want a forced re-auth (matches
        // Gemini CLI semantics — running auth again is a "let me log in
        // from scratch", not "verify my existing session"). A separate
        // /mcp logout exists for users who just want to clear without
        // re-authing.
        try {
          await getTokenStorage().clear(subArg)
        } catch {
          // best-effort; an unwritable token store still lets the rest
          // of the flow run and the user will see the actual failure
          // when finishAuth tries to save.
        }
        addCommandMessage(text, `Authenticating "${subArg}" — opening browser...`)
        try {
          const server = await registry.authenticateServer(subArg, {
            onBrowserOpen: (url) => {
              addCommandResult(`Opened ${url}\nWaiting for the authorization redirect...`)
            },
          })
          if (server.status.kind === 'connected') {
            // Tool surface may have grown — invalidate cache so the next
            // turn rebuilds the system prompt with the newly-available
            // tools.
            invalidateSystemPromptCache()
            addCommandResult(
              `✓ Authenticated "${subArg}" — ${server.status.toolCount} tool${
                server.status.toolCount === 1 ? '' : 's'
              }, ${server.status.resourceCount} resource${server.status.resourceCount === 1 ? '' : 's'}`,
            )
          } else if (server.status.kind === 'needs_auth') {
            addCommandResult(`⚠ Server still needs auth. The browser flow may have been cancelled.`)
          } else if (server.status.kind === 'failed') {
            addCommandResult(`✗ Auth completed but server failed to connect: ${server.status.error}`)
          } else {
            addCommandResult(`Server is now in state: ${server.status.kind}`)
          }
        } catch (err) {
          addCommandResult(`✗ Authentication failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'logout': {
        if (!subArg) {
          addCommandMessage(text, 'Usage: /mcp logout <server-name>')
          return
        }
        try {
          await getTokenStorage().clear(subArg)
          addCommandMessage(
            text,
            `Removed stored OAuth tokens for "${subArg}". Run /mcp auth ${subArg} to log in again.`,
          )
        } catch (err) {
          addCommandMessage(text, `Failed to clear tokens: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'refresh': {
        if (!registry) {
          addCommandMessage(text, 'No MCP registry to refresh.')
          return
        }
        addCommandMessage(text, 'Re-reading MCP config and reconnecting servers...')
        try {
          // Include plugin-contributed mcpServers in the merged map. Without
          // this, a `/mcp refresh` run after a plugin install would silently
          // drop every plugin-contributed server because the merged map only
          // had user + project entries. The helper degrades to `{}` on any
          // plugin-scan failure (logged to debug.log) so an MCP-only refresh
          // doesn't fail because of an unrelated plugin-system hiccup.
          const extraServers = options.pluginRegistry ? await getPluginMcpServersFromDisk(process.cwd()) : undefined
          const { configs, configErrors, projectSkipped } = await loadMergedConfigsFromDisk({
            cwd: process.cwd(),
            askUser: (q, opts) => askQuestion(q, opts, { noOther: true }),
            extraServers,
          })
          const summary = await registry.restartAll(configs)
          invalidateSystemPromptCache()

          const parts: string[] = []
          if (summary.added.length) parts.push(`added: ${summary.added.join(', ')}`)
          if (summary.removed.length) parts.push(`removed: ${summary.removed.join(', ')}`)
          if (summary.changed.length) parts.push(`changed: ${summary.changed.join(', ')}`)
          if (summary.unchanged.length) parts.push(`reconnected: ${summary.unchanged.join(', ')}`)
          if (parts.length === 0) parts.push('no servers configured')
          const lines = [`Reloaded MCP — ${parts.join('; ')}.`]
          lines.push(`Note: next message rebuilds the system prompt, so prompt-cache will miss once.`)
          if (projectSkipped) lines.push('Project-level MCP servers were skipped (not trusted).')
          for (const e of configErrors) lines.push(`Config error in ${e.name}: ${e.message}`)
          addCommandResult(lines.join('\n'))
        } catch (err) {
          addCommandResult(`✗ Refresh failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        return
      }
      case 'add':
        await handleMcpAdd(text, subArg)
        return

      case 'add-json':
        await handleMcpAddJson(text, subArg)
        return

      case 'remove':
      case 'rm':
        await handleMcpRemove(text, subArg)
        return

      default: {
        addCommandMessage(
          text,
          `Unknown subcommand: /mcp ${sub}. Available: list, tools, add, add-json, remove, auth, logout, refresh.`,
        )
        return
      }
    }
  }

  return { handleMcp }
}
