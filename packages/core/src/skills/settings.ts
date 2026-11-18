// Skill settings — disabledSkills list per scope.
//
// User scope:     ~/.x-code/settings.json
// Project scope:  <repo-root>/.x-code/settings.local.json (gitignored)
//
// Both files share the shape `{ disabledSkills?: string[] }`. A skill is
// effectively disabled when its name appears in EITHER scope's list — we
// take the union, not an override. To re-enable from a user-scope disable
// while keeping it disabled elsewhere, remove the name from the user-scope
// list. The settings files are session-immutable: SkillRegistry filters
// on this list at startup, so toggle/remove takes effect on next launch.
import path from 'node:path'

import { mutateSettingsFile, readSettingsFile } from '../settings-io.js'
import { XCODE_DIR, userXcodeDir } from '../utils.js'
import { collectProjectSkillDirs } from './loader.js'

export type SkillSettingsScope = 'user' | 'project'

interface SkillSettings {
  disabledSkills?: string[]
}

export function skillSettingsPath(scope: SkillSettingsScope, cwd: string = process.cwd()): string {
  if (scope === 'user') return path.join(userXcodeDir(), 'settings.json')
  return path.join(cwd, XCODE_DIR, 'settings.local.json')
}

function disabledSkillsFrom(obj: Record<string, unknown>): string[] {
  const list = Array.isArray(obj.disabledSkills)
    ? (obj.disabledSkills as unknown[]).filter((s): s is string => typeof s === 'string')
    : []
  return list
}

async function readSettings(scope: SkillSettingsScope, cwd?: string): Promise<SkillSettings> {
  const obj = await readSettingsFile(skillSettingsPath(scope, cwd))
  return { disabledSkills: disabledSkillsFrom(obj) }
}

export async function loadDisabledSkillsSet(cwd: string = process.cwd()): Promise<Set<string>> {
  const projectDirs = await collectProjectSkillDirs(cwd)
  const [u, ...projectSets] = await Promise.all([
    readSettings('user', cwd),
    ...projectDirs.map((dir) => readSettings('project', dir)),
  ])
  const merged = new Set<string>()
  for (const name of u.disabledSkills ?? []) merged.add(name)
  for (const p of projectSets) {
    for (const name of p.disabledSkills ?? []) merged.add(name)
  }
  return merged
}

/** Toggle a skill's disabled state in the given scope. `disable=true` adds
 *  the name; `disable=false` removes it. Returns the action that actually
 *  happened so the caller can render an accurate message
 *  ("already disabled" vs "disabled"). */
export async function setSkillDisabled(
  name: string,
  scope: SkillSettingsScope,
  disable: boolean,
): Promise<'changed' | 'noop'> {
  const changed = await mutateSettingsFile(skillSettingsPath(scope), (existing) => {
    const list = new Set(disabledSkillsFrom(existing))
    const had = list.has(name)
    if (disable === had) return false

    if (disable) list.add(name)
    else list.delete(name)

    if (list.size === 0) delete existing.disabledSkills
    else existing.disabledSkills = [...list].sort()
    return true
  })
  return changed ? 'changed' : 'noop'
}

export async function getScopedDisabledSkills(scope: SkillSettingsScope): Promise<string[]> {
  const s = await readSettings(scope)
  return s.disabledSkills ?? []
}
