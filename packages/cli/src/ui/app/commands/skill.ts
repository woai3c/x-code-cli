// @x-code-cli/cli — /skill slash command handler.
//
// Extracted from App.tsx via a factory that closes over the deps each
// subcommand needs: registry access (read + reload), settings writers,
// prompt-cache invalidation, and the pending-skill ref. Returns the
// handler function the dispatcher in App.tsx calls.
//
// Subcommands: install / list / refresh / disable / enable / uninstall.
// Unknown subs print the usage hint.
import fs from 'node:fs/promises'
import path from 'node:path'

import {
  getScopedDisabledSkills,
  reloadSkillRegistry,
  setSkillDisabled,
  skillSettingsPath,
  userSkillsDir,
} from '@x-code-cli/core'
import type { AgentOptions, SkillDefinition, SkillEntry, SkillSettingsScope } from '@x-code-cli/core'

import { parseScopeFlag } from './scope-flag.js'

export interface SkillCommandDeps {
  options: AgentOptions
  addCommandMessage: (text: string, content: string) => void
  invalidateSystemPromptCache: () => void
  pendingSkillRef: { current: SkillDefinition | null }
  bumpSkillRegistryVersion: () => void
}

/** Minimal YAML name extractor for SKILL.md frontmatter.
 *  Only needs to find `name: <value>` — full parse happens in the loader. */
function extractSkillName(content: string): string | null {
  const match = content.match(/^---\r?\n[\s\S]*?^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)
  return match ? match[1].trim() : null
}

function isSafeSkillDirName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    path.basename(name) === name
  )
}

function formatSkillProvenance(skill: SkillEntry): string {
  if (skill.pluginId) return `plugin: ${skill.pluginId}`
  if (skill.origin === 'agents') return skill.source === 'user' ? 'user · ~/.agents' : 'project · .agents'
  if (skill.origin === 'claude') return skill.source === 'user' ? 'user · ~/.claude' : 'project · .claude'
  if (skill.origin === 'xcode') return skill.source === 'user' ? 'user · ~/.x-code' : 'project · .x-code'
  return skill.source
}

/** Split a skill argument into `(name, scope)`, recognizing
 *  `--scope=user` / `--scope=project` / `-s=user` etc. Bare arg with
 *  no flag returns `scope: undefined` so the caller can default off the
 *  skill's source. Unknown scope strings are ignored (scope stays
 *  undefined) — keeps the parser permissive. */
function parseSkillScopeFlag(arg: string): { name: string; scope?: SkillSettingsScope } {
  const { value, scope } = parseScopeFlag(arg)
  return { name: value, scope }
}

export function createSkillCommandHandler(deps: SkillCommandDeps) {
  const { options, addCommandMessage, invalidateSystemPromptCache, pendingSkillRef, bumpSkillRegistryVersion } = deps

  async function handleSkill(text: string, arg: string): Promise<void> {
    const parts = arg.trim().split(/\s+/)
    const sub = parts[0]?.toLowerCase()
    const subArg = parts.slice(1).join(' ').trim()

    if (sub === 'install') {
      if (!subArg) {
        addCommandMessage(text, 'Usage: `/skill install <url>`')
        return
      }
      let content: string
      try {
        const res = await fetch(subArg)
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
        content = await res.text()
      } catch (err) {
        addCommandMessage(text, `Failed to fetch \`${subArg}\`: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      const name = extractSkillName(content)
      if (!name) {
        addCommandMessage(text, 'Invalid SKILL.md: missing `name` in frontmatter.')
        return
      }
      if (!isSafeSkillDirName(name)) {
        addCommandMessage(text, `Invalid SKILL.md: unsafe skill name \`${name}\`.`)
        return
      }

      const skillDir = path.join(userSkillsDir(), name)
      const skillFile = path.join(skillDir, 'SKILL.md')
      try {
        await fs.mkdir(skillDir, { recursive: true })
        await fs.writeFile(skillFile, content, 'utf-8')
      } catch (err) {
        addCommandMessage(text, `Failed to save skill: ${err instanceof Error ? err.message : String(err)}`)
        return
      }

      addCommandMessage(
        text,
        `Skill **${name}** installed to \`${skillFile}\`\nRun \`/skill refresh\` to use \`/${name}\` now, or restart xc.`,
      )
      return
    }

    if (sub === 'list') {
      const skills = options.skillRegistry?.listAll() ?? []
      if (skills.length === 0) {
        const skillsPath = path.join(userSkillsDir(), '<name>', 'SKILL.md')
        addCommandMessage(
          text,
          `No skills loaded. Place SKILL.md files in \`.agents/skills/<name>/SKILL.md\` or \`${skillsPath}\` then run \`/skill refresh\` (or restart).`,
        )
        return
      }
      const lines = skills.map((s) => {
        const tag = s.disabled ? '[off]' : '[on] '
        return `- ${tag} **${s.name}** (${formatSkillProvenance(s)}): ${s.description}`
      })
      addCommandMessage(text, `**Loaded skills** (${skills.length}):\n${lines.join('\n')}`)
      return
    }

    if (sub === 'refresh') {
      if (!options.skillRegistry) {
        addCommandMessage(text, 'No skill registry to refresh.')
        return
      }
      let summary
      try {
        summary = await reloadSkillRegistry(options.skillRegistry)
      } catch (err) {
        addCommandMessage(text, `Failed to reload skills: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // Invalidate prompt cache: both the system prompt's `## Available
      // Skills` block and the activateSkill tool description embed the
      // skill list. Better to take one cache miss than to send a stale
      // skill surface to the model. Same trade /mcp refresh makes.
      invalidateSystemPromptCache()
      // Drop a pending skill if the user `/<skillname>` for a skill that
      // was just removed or disabled — otherwise the next plain user
      // message would inject orphaned skill content.
      const pending = pendingSkillRef.current
      if (pending && !options.skillRegistry.get(pending.name)) {
        pendingSkillRef.current = null
      }
      // Force the slash-command tab completion + /help list to re-memo
      // off the new skill set. The registry object identity is stable
      // (reload() mutates in place), so the version counter is the
      // signal React needs to recompute the memoized list.
      bumpSkillRegistryVersion()

      const summaryParts: string[] = []
      if (summary.added.length) summaryParts.push(`added: ${summary.added.join(', ')}`)
      if (summary.removed.length) summaryParts.push(`removed: ${summary.removed.join(', ')}`)
      if (summary.changed.length) summaryParts.push(`changed: ${summary.changed.join(', ')}`)
      if (summary.unchanged.length) summaryParts.push(`unchanged: ${summary.unchanged.join(', ')}`)
      if (summaryParts.length === 0) summaryParts.push('no skills found')
      const lines = [`Reloaded skills — ${summaryParts.join('; ')}.`]
      // Tight `\n` between primary result and the advisory note — matches the
      // pattern used by /mcp refresh and the rest of /skill install / disable /
      // enable / remove. No blank line within a single command's result block.
      lines.push('Note: next message rebuilds the system prompt, so prompt-cache will miss once.')
      addCommandMessage(text, lines.join('\n'))
      return
    }

    if (sub === 'disable' || sub === 'enable') {
      const name = subArg.trim()
      if (!name) {
        addCommandMessage(text, `Usage: \`/skill ${sub} <name> [--scope=user|project]\``)
        return
      }
      const { name: bareName, scope } = parseSkillScopeFlag(name)
      const entry = options.skillRegistry?.getEntry(bareName)
      if (!entry) {
        addCommandMessage(
          text,
          `No skill named \`${bareName}\` is loaded. Run \`/skill list\` to see available skills.`,
        )
        return
      }
      // Default the disable scope to the skill's own source so users get the
      // expected "disable the project skill yansu" without typing --scope.
      // Re-enable is symmetric: clear from the source scope first; if the
      // skill is still effectively disabled it's because the OTHER scope
      // also lists it, and we'll surface that.
      const canonicalName = entry.name
      const effectiveScope: SkillSettingsScope = scope ?? entry.source
      const disable = sub === 'disable'
      let result: 'changed' | 'noop'
      try {
        result = await setSkillDisabled(canonicalName, effectiveScope, disable)
      } catch (err) {
        addCommandMessage(text, `Failed to update settings: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      const settingsFile = skillSettingsPath(effectiveScope)
      if (result === 'noop') {
        addCommandMessage(
          text,
          disable
            ? `Skill **${canonicalName}** is already disabled in ${effectiveScope} settings (\`${settingsFile}\`).`
            : `Skill **${canonicalName}** is not disabled in ${effectiveScope} settings (\`${settingsFile}\`).`,
        )
        return
      }
      // After re-enable, check whether the other scope is still hiding it
      // — common pitfall when the user disables at user scope and then expects
      // a project-level enable to revive it.
      let otherScopeNote = ''
      if (!disable) {
        const other: SkillSettingsScope = effectiveScope === 'user' ? 'project' : 'user'
        try {
          const stillDisabled = (await getScopedDisabledSkills(other)).includes(canonicalName)
          if (stillDisabled) {
            otherScopeNote = `\n_Note: \`${canonicalName}\` is also listed in ${other} settings (\`${skillSettingsPath(other)}\`). Run \`/skill enable ${canonicalName} --scope=${other}\` to fully re-enable._`
          }
        } catch {
          // best-effort hint — silent failure is fine
        }
      }
      const verb = disable ? 'Disabled' : 'Enabled'
      addCommandMessage(
        text,
        `${verb} skill **${canonicalName}** in ${effectiveScope} settings (\`${settingsFile}\`).${otherScopeNote}\nRun \`/skill refresh\` to apply now, or restart xc.`,
      )
      return
    }

    if (sub === 'uninstall') {
      const name = subArg.trim()
      if (!name) {
        addCommandMessage(text, 'Usage: `/skill uninstall <name>`')
        return
      }
      const entry = options.skillRegistry?.getEntry(name)
      if (!entry) {
        addCommandMessage(text, `No skill named \`${name}\` is loaded. Run \`/skill list\` to see available skills.`)
        return
      }
      // Plugin-contributed skills live under the plugin's cache dir, not
      // under <baseDir>/skills/. `/skill uninstall` here would compute the
      // wrong path and either no-op silently or remove an unrelated dir
      // — redirect the user to `/plugin uninstall` instead.
      if (entry.pluginId) {
        addCommandMessage(
          text,
          `Skill **${name}** comes from plugin \`${entry.pluginId}\` — uninstall it with \`/plugin uninstall ${entry.pluginId}\` instead of \`/skill uninstall\`.`,
        )
        return
      }
      if (entry.origin === 'claude') {
        addCommandMessage(
          text,
          `Skill **${name}** comes from Claude Code's skills directory (\`${entry.dir}\`), which X-Code treats as read-only.\nUse \`/skill disable ${name}\` to hide it in X-Code, or remove \`${entry.dir}\` manually.`,
        )
        return
      }
      const skillDir = path.resolve(entry.dir)
      if (skillDir === path.parse(skillDir).root) {
        addCommandMessage(text, `Refusing to remove unsafe skill directory \`${skillDir}\`.`)
        return
      }
      try {
        const stat = await fs.lstat(skillDir)
        if (stat.isSymbolicLink()) {
          try {
            await fs.unlink(skillDir)
          } catch {
            // Windows directory junctions require non-recursive rmdir rather than unlink.
            await fs.rmdir(skillDir)
          }
        } else {
          await fs.rm(skillDir, { recursive: true, force: true })
        }
      } catch (err) {
        addCommandMessage(text, `Failed to remove \`${skillDir}\`: ${err instanceof Error ? err.message : String(err)}`)
        return
      }
      // Also clear any disable entries — leaving stale entries pointing
      // at an uninstalled skill would silently swallow a future re-install
      // with the same name (it'd come back disabled).
      try {
        await setSkillDisabled(entry.name, 'user', false)
        await setSkillDisabled(entry.name, 'project', false)
      } catch {
        // best-effort — main rm already succeeded
      }
      addCommandMessage(
        text,
        `Uninstalled skill **${entry.name}** from \`${skillDir}\`.\nRun \`/skill refresh\` to apply now, or restart xc.`,
      )
      return
    }

    addCommandMessage(
      text,
      'Usage: `/skill install <url>` · `/skill list` · `/skill refresh` · `/skill disable <name>` · `/skill enable <name>` · `/skill uninstall <name>`',
    )
  }

  return { handleSkill }
}
