// @x-code-cli/core — Slash command registry
//
// Built once at CLI startup from plugin-contributed command files.
// Lookups happen from the App.tsx default slash-dispatcher when a typed
// `/<name>` doesn't match any built-in command or skill. Same
// startup-frozen / byte-stability model as SkillRegistry.
import fs from 'node:fs'

import { pluginDataDir } from '../plugins/paths.js'
import { type LoadCommandsOptions, loadPluginCommands } from './loader.js'
import type { CommandDefinition } from './types.js'

/** Diff returned by reload — drives the /plugin refresh message. */
export interface CommandReloadSummary {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

export class CommandRegistry {
  private byName: Map<string, CommandDefinition>

  constructor(commands: ReadonlyArray<CommandDefinition> = []) {
    this.byName = new Map()
    // Last-write wins on name collision (consistent with how
    // SkillRegistry merges user → plugin → project).
    for (const c of commands) this.byName.set(c.name, c)
  }

  get(name: string): CommandDefinition | undefined {
    return this.byName.get(name)
  }

  list(): CommandDefinition[] {
    return [...this.byName.values()]
  }

  names(): string[] {
    return [...this.byName.keys()]
  }

  /** Replace the in-memory command set with a fresh load. Used by
   *  /plugin refresh — keeps registry identity stable so captured
   *  `options.commandRegistry` references stay valid. */
  reload(commands: ReadonlyArray<CommandDefinition>): CommandReloadSummary {
    const previous = this.byName
    const next = new Map<string, CommandDefinition>()
    for (const c of commands) next.set(c.name, c)
    const summary: CommandReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
    for (const [name, cmd] of next) {
      const prev = previous.get(name)
      if (!prev) summary.added.push(name)
      else if (prev.body !== cmd.body || prev.pluginId !== cmd.pluginId || prev.pluginRoot !== cmd.pluginRoot)
        summary.changed.push(name)
      else summary.unchanged.push(name)
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) summary.removed.push(name)
    }
    this.byName = next
    return summary
  }
}

export async function createCommandRegistry(opts: LoadCommandsOptions = {}): Promise<CommandRegistry> {
  const commands = await loadPluginCommands(opts)
  return new CommandRegistry(commands)
}

/** Re-scan plugin command dirs and rebuild the registry in place.
 *  Caller is responsible for passing the latest plugin-derived extraDirs. */
export async function reloadCommandRegistry(
  registry: CommandRegistry,
  opts: LoadCommandsOptions = {},
): Promise<CommandReloadSummary> {
  const commands = await loadPluginCommands(opts)
  return registry.reload(commands)
}

/** Apply Claude Code-style placeholder substitutions to a command
 *  body before sending it as a model prompt. Recognised placeholders
 *  match real Claude Code plugin command files (verified against
 *  `anthropics/claude-code/plugins/<plugin>/commands/<cmd>.md`):
 *
 *    $ARGUMENTS  /  ${ARGUMENTS}    — text the user typed after the
 *                                     command name (`/code-review 123`
 *                                     → `123`). Empty string when no
 *                                     argument was given.
 *    ${CLAUDE_PLUGIN_ROOT}          — absolute path to the owning
 *                                     plugin's installed dir (versioned;
 *                                     wiped on reinstall).
 *    ${CLAUDE_PLUGIN_DATA}          — persistent per-plugin data dir
 *                                     (`~/.x-code/plugins/data/<id>/`)
 *                                     that survives reinstalls and
 *                                     upgrades. Auto-created on first
 *                                     substitution. Left verbatim when
 *                                     the command has no plugin context. */
export function expandCommandBody(cmd: CommandDefinition, args: string): string {
  const root = cmd.pluginRoot ?? ''
  let dataDir = ''
  if (cmd.pluginId && cmd.body.includes('${CLAUDE_PLUGIN_DATA}')) {
    dataDir = pluginDataDir(cmd.pluginId)
    try {
      fs.mkdirSync(dataDir, { recursive: true })
    } catch {
      // mkdir failure leaves dataDir set to the path string anyway —
      // the user's shell script will surface a sensible error if it
      // actually tries to write there.
    }
  }
  return cmd.body
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', root)
    .replaceAll('${CLAUDE_PLUGIN_DATA}', dataDir)
    .replaceAll('${ARGUMENTS}', args)
    .replaceAll('$ARGUMENTS', args)
}
