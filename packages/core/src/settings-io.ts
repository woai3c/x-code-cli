// @x-code-cli/core — Shared JSON settings file read/modify/write
//
// Skills (disabledSkills) and plugins (enabledPlugins) both use the same
// physical settings.json files (user-scope and project-scope). This module
// provides the shared read-modify-write plumbing so each subsystem only
// needs to deal with its own field logic.
import fs from 'node:fs/promises'
import path from 'node:path'

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

/** Write a settings object back to disk, creating parent directories as needed.
 *  Uses 2-space indentation + trailing newline matching the project convention. */
export async function writeSettingsFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

/** Read-modify-write a settings.json file atomically. The mutator receives the
 *  current file contents and can modify the object in place. */
export async function mutateSettingsFile(
  filePath: string,
  mutator: (data: Record<string, unknown>) => void,
): Promise<void> {
  const data = await readSettingsFile(filePath)
  mutator(data)
  await writeSettingsFile(filePath, data)
}
