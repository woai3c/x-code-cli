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

export type SkillSettingsScope = 'user' | 'project'

export interface SkillSettings {
  disabledSkills?: string[]
}

export function skillSettingsPath(scope: SkillSettingsScope): string {
  if (scope === 'user') return path.join(userXcodeDir(), 'settings.json')
  return path.join(process.cwd(), XCODE_DIR, 'settings.local.json')
}

async function readSettings(scope: SkillSettingsScope): Promise<SkillSettings> {
  const obj = await readSettingsFile(skillSettingsPath(scope))
  const list = Array.isArray(obj.disabledSkills)
    ? (obj.disabledSkills as unknown[]).filter((s): s is string => typeof s === 'string')
    : []
  return { disabledSkills: list }
}

async function writeSettings(scope: SkillSettingsScope, settings: SkillSettings): Promise<void> {
  const file = skillSettingsPath(scope)
  await mutateSettingsFile(file, (existing) => {
    const list = settings.disabledSkills ?? []
    if (list.length === 0) {
      delete existing.disabledSkills
    } else {
      existing.disabledSkills = list
    }
  })
}

export async function loadDisabledSkillsSet(): Promise<Set<string>> {
  const [u, p] = await Promise.all([readSettings('user'), readSettings('project')])
  const merged = new Set<string>()
  for (const name of u.disabledSkills ?? []) merged.add(name)
  for (const name of p.disabledSkills ?? []) merged.add(name)
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
  const current = await readSettings(scope)
  const list = new Set(current.disabledSkills ?? [])
  const had = list.has(name)
  if (disable) {
    if (had) return 'noop'
    list.add(name)
  } else {
    if (!had) return 'noop'
    list.delete(name)
  }
  await writeSettings(scope, { disabledSkills: [...list].sort() })
  return 'changed'
}

export async function getScopedDisabledSkills(scope: SkillSettingsScope): Promise<string[]> {
  const s = await readSettings(scope)
  return s.disabledSkills ?? []
}
