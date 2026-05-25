// @x-code-cli/core — Skill registry
//
// Built once at CLI startup and reused across the session. The skill list
// is embedded in two byte-stable surfaces — the system prompt's
// `## Available Skills` block and the `activateSkill` tool description —
// both cached on LoopState.systemPromptCache. Adding, removing, enabling,
// or disabling a skill therefore needs to either (a) run before the next
// streamText call AND invalidate that cache, or (b) wait for a CLI
// restart. The /skill disable|enable|remove handlers do (b) — they write
// settings to disk and print a "Restart the CLI to apply." hint. The
// /skill refresh handler does (a) — it calls `reloadSkillRegistry()` on
// this object to rebuild the internal map in place, then triggers a
// systemPromptCache invalidation so the next turn picks up the change.
// Keeping the same SkillRegistry object reference across refresh means
// every other code path that captured `options.skillRegistry` (agent
// loop's buildTools, App.tsx's slash-command tab completion, …) stays
// pointed at the right thing without needing to be re-wired.
import { type LoadSkillsOptions, loadSkills } from './loader.js'
import { loadDisabledSkillsSet } from './settings.js'

export interface SkillDefinition {
  name: string
  description: string
  content: string
  source: 'user' | 'project'
  /** Absolute path to the skill's directory (the one containing SKILL.md).
   *  Used at activation time so the model can resolve relative paths to
   *  bundled scripts / references / assets. */
  dir: string
  /** Relative paths of files in the skill directory, excluding SKILL.md and
   *  hidden / heavy directories. Listed at activation time alongside the body
   *  so the model knows what bundled resources exist without globbing. Capped
   *  at MAX_LISTED_FILES — long lists get truncated with a "... N more" marker. */
  files: string[]
  /** When this skill comes from a plugin contribution, the owning plugin's
   *  id (`name@marketplace`). UI shows this as "(from plugin: …)" and
   *  `/skill uninstall` redirects to `/plugin uninstall`. */
  pluginId?: string
}

export interface SkillEntry extends SkillDefinition {
  disabled: boolean
}

/** Summary returned by `reloadSkillRegistry()`. Drives the message
 *  surface in /skill refresh — caller can show "added: a, b" /
 *  "removed: c" / "unchanged: d, e" the same way /mcp refresh does. */
export interface SkillReloadSummary {
  added: string[]
  removed: string[]
  changed: string[]
  unchanged: string[]
}

export class SkillRegistry {
  private byName: Map<string, SkillEntry>

  constructor(skills: SkillDefinition[], disabled: ReadonlySet<string> = new Set()) {
    this.byName = new Map()
    // Last-write wins: project skills override user-scope skills of the
    // same name because loadSkills() returns user-scope first, then project.
    for (const skill of skills) {
      this.byName.set(skill.name, { ...skill, disabled: disabled.has(skill.name) })
    }
  }

  /** Replace the in-memory skill list with a fresh load. Used by
   *  /skill refresh — keeps the same SkillRegistry object identity so
   *  every cached `options.skillRegistry` reference (agent loop, CLI
   *  slash completion, App.tsx handlers) keeps pointing at the right
   *  thing. Returns a per-name diff vs the previous state so the
   *  caller can render an "added / removed / changed / unchanged"
   *  summary in the user-facing message. */
  reload(skills: SkillDefinition[], disabled: ReadonlySet<string>): SkillReloadSummary {
    const previous = this.byName
    const next = new Map<string, SkillEntry>()
    for (const skill of skills) {
      next.set(skill.name, { ...skill, disabled: disabled.has(skill.name) })
    }

    const summary: SkillReloadSummary = { added: [], removed: [], changed: [], unchanged: [] }
    for (const [name, entry] of next) {
      const prev = previous.get(name)
      if (!prev) {
        summary.added.push(name)
      } else if (
        prev.description !== entry.description ||
        prev.content !== entry.content ||
        prev.source !== entry.source ||
        prev.disabled !== entry.disabled
      ) {
        summary.changed.push(name)
      } else {
        summary.unchanged.push(name)
      }
    }
    for (const name of previous.keys()) {
      if (!next.has(name)) summary.removed.push(name)
    }

    this.byName = next
    return summary
  }

  /** Enabled skill by name. Disabled skills are hidden from the agent loop
   *  and slash-command dispatch — use `getEntry()` if you need to inspect
   *  the disabled flag (the /skill list handler does). */
  get(name: string): SkillDefinition | undefined {
    const entry = this.byName.get(name)
    if (!entry || entry.disabled) return undefined
    return entry
  }

  /** Enabled skills only. */
  list(): SkillDefinition[] {
    return [...this.byName.values()].filter((s) => !s.disabled)
  }

  /** Enabled skill names only. */
  names(): string[] {
    return [...this.byName.values()].filter((s) => !s.disabled).map((s) => s.name)
  }

  /** Every loaded skill, with `disabled` flag. Used by /skill list and the
   *  disable/enable/remove handlers so they can act on disabled skills too. */
  listAll(): SkillEntry[] {
    return [...this.byName.values()]
  }

  getEntry(name: string): SkillEntry | undefined {
    return this.byName.get(name)
  }
}

/** Hard upper bound mirrored from loader's MAX_LISTED_FILES — the
 *  injection formatter caps the rendered file list at the same value so
 *  the two stay aligned. Loader sorts + truncates first, this function
 *  treats `skill.files` as already-bounded. */
const MAX_RENDERED_FILES = 50

/** Build the exact text that goes inside `<activated_skill name="...">...</activated_skill>`
 *  for both activation paths (model self-decide via `activateSkill` tool, and
 *  user explicit `/<skillname>`). Format follows Opencode's convention: body
 *  first, then a footer with base directory + relative-paths hint + file list.
 *  Sharing one formatter between the two call sites keeps the byte stream the
 *  model sees identical regardless of who triggered activation. */
export function formatSkillActivationBody(skill: SkillDefinition): string {
  const lines: string[] = [skill.content.trim(), '']
  lines.push(`Base directory for this skill: ${skill.dir}`)
  lines.push(
    'Relative paths in this skill (e.g., scripts/foo.sh, references/api.md) are resolved against the base directory above.',
  )
  if (skill.files.length > 0) {
    lines.push('', 'Files in this skill directory:')
    const shown = skill.files.slice(0, MAX_RENDERED_FILES)
    for (const f of shown) lines.push(`- ${f}`)
    if (skill.files.length > MAX_RENDERED_FILES) {
      lines.push(`- ... and ${skill.files.length - MAX_RENDERED_FILES} more file(s) not shown`)
    }
  }
  return lines.join('\n')
}

/** Wrap a skill's activation body in the `<activated_skill name="X">`
 *  XML envelope. Used by both activation paths so the wrapper is byte-
 *  identical regardless of trigger. */
export function wrapActivatedSkill(skill: SkillDefinition): string {
  return `<activated_skill name="${skill.name}">\n${formatSkillActivationBody(skill)}\n</activated_skill>`
}

export async function createSkillRegistry(opts: LoadSkillsOptions = {}): Promise<SkillRegistry> {
  const [skills, disabled] = await Promise.all([loadSkills(opts), loadDisabledSkillsSet()])
  return new SkillRegistry(skills, disabled)
}

/** Re-scan skill directories + settings.json, then mutate the given
 *  registry in place. Caller is responsible for invalidating any
 *  systemPromptCache that embedded the previous skill list — the
 *  /skill refresh handler does exactly this. */
export async function reloadSkillRegistry(
  registry: SkillRegistry,
  opts: LoadSkillsOptions = {},
): Promise<SkillReloadSummary> {
  const [skills, disabled] = await Promise.all([loadSkills(opts), loadDisabledSkillsSet()])
  return registry.reload(skills, disabled)
}
