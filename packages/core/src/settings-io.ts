// @x-code-cli/core — Shared JSON settings file read/modify/write
//
// Skills (disabledSkills) and plugins (enabledPlugins) both use the same
// physical settings.json files (user-scope and project-scope). This module
// provides the shared read-modify-write plumbing so each subsystem only
// needs to deal with its own field logic.
import fs from 'node:fs/promises'

import { atomicWriteFile } from './utils/atomic-file.js'

/** Read a settings.json file, tolerating missing files and malformed JSON.
 *  Returns a mutable shallow copy — safe to mutate then pass to writeSettingsFile. */
export async function readSettingsFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) }
    }
    return {}
  } catch {
    return {}
  }
}

/** Write a settings object back to disk without exposing a partial JSON file. */
async function writeSettingsFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  await atomicWriteFile(filePath, JSON.stringify(data, null, 2) + '\n')
}

/** Read-modify-write a settings.json file. The mutator returns true only when
 *  it changed the object, avoiding unnecessary writes for no-op updates. */
export async function mutateSettingsFile(
  filePath: string,
  mutator: (data: Record<string, unknown>) => boolean,
): Promise<boolean> {
  const data = await readSettingsFile(filePath)
  const changed = mutator(data)
  if (!changed) return false
  await writeSettingsFile(filePath, data)
  return true
}
