// @x-code-cli/core — File-based command loader
//
// Scans plugin-contributed `commands/` directories for `*.md` files and
// returns CommandDefinitions ready to register in CommandRegistry.
// Mirrors the sub-agents loader's structure — same minimal YAML
// frontmatter parser, same "one bad file logged + skipped, never
// crash the boot" error handling.
import fs from 'node:fs/promises'
import path from 'node:path'

import { XCODE_DIR, userXcodeDir } from '../utils.js'
import type { CommandDefinition } from './types.js'

/** Minimal YAML frontmatter parser. Same subset used by skills /
 *  sub-agents loaders — string scalars only, no dependency on
 *  gray-matter. Folds indented continuation lines into the previous
 *  line so the multi-line `allowed-tools` form that real Claude Code
 *  commands use parses without complaint (we ignore the value, but
 *  the parse mustn't choke). */
function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]!
  const body = match[2]!
  const data: Record<string, unknown> = {}

  const folded: string[] = []
  for (const line of yamlBlock.split(/\r?\n/)) {
    if (/^\s/.test(line) && line.trim() && folded.length > 0) {
      folded[folded.length - 1] += ' ' + line.trim()
    } else {
      folded.push(line)
    }
  }

  for (const line of folded) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 1) continue
    const key = trimmed.slice(0, colonIdx).trim()
    let value: string = trimmed.slice(colonIdx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[key] = value
  }

  return { data, body }
}

async function loadCommandsFromDir(
  dir: string,
  source: CommandDefinition['source'],
  pluginId?: string,
  pluginRoot?: string,
): Promise<CommandDefinition[]> {
  const out: CommandDefinition[] = []
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return out
  }

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const filePath = path.join(dir, entry)
    const name = entry.slice(0, -3) // strip .md

    try {
      const raw = await fs.readFile(filePath, 'utf-8')
      const parsed = parseFrontmatter(raw)
      // Commands without frontmatter are still valid — the whole file
      // becomes the body. Real Claude Code commands always have
      // frontmatter, but be permissive.
      const description = parsed?.data.description as string | undefined
      const body = (parsed ? parsed.body : raw).trim()

      const cmd: CommandDefinition = {
        name,
        description,
        body,
        source,
      }
      // pluginId / pluginRoot only meaningful for plugin-sourced commands.
      // For user / project commands ${CLAUDE_PLUGIN_ROOT} falls back to ''
      // via expandCommandBody — safe no-op.
      if (pluginId) cmd.pluginId = pluginId
      if (pluginRoot) cmd.pluginRoot = pluginRoot
      out.push(cmd)
    } catch (err) {
      console.error(`[commands] Skipping ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return out
}

export interface LoadCommandsOptions {
  /** Plugin-contributed command directories, each tagged with the
   *  owning plugin's id and root dir. Order determines registry
   *  insertion order (last-wins on name conflict). */
  extraDirs?: ReadonlyArray<{ dir: string; pluginId: string; pluginRoot: string }>
}

/** Load slash commands from user (`~/.x-code/commands/*.md`) + plugin
 *  (extraDirs) + project (`<cwd>/.x-code/commands/*.md`) sources.
 *  Merge order is user → plugin → project so CommandRegistry's
 *  last-write-wins yields the precedence **project > plugin > user** —
 *  same as skills + sub-agents. `userXcodeDir()` is called at load time so
 *  `X_CODE_HOME` (used by tests) redirects the user-scope path. */
export async function loadPluginCommands(opts: LoadCommandsOptions = {}): Promise<CommandDefinition[]> {
  const userDir = path.join(userXcodeDir(), 'commands')
  const projectDir = path.join(process.cwd(), XCODE_DIR, 'commands')

  const userCmds = await loadCommandsFromDir(userDir, 'user')
  const pluginCmds: CommandDefinition[] = []
  for (const { dir, pluginId, pluginRoot } of opts.extraDirs ?? []) {
    pluginCmds.push(...(await loadCommandsFromDir(dir, 'plugin', pluginId, pluginRoot)))
  }
  const projectCmds = await loadCommandsFromDir(projectDir, 'project')

  return [...userCmds, ...pluginCmds, ...projectCmds]
}
