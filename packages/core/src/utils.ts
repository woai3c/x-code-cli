// @x-code-cli/core — Shared utilities and constants
import fsSync from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Project-local config directory name */
export const XCODE_DIR = '.x-code'

/** Global config directory (~/.x-code) */
export const GLOBAL_XCODE_DIR = path.join(os.homedir(), '.x-code')

// ── Debug log (shared by core + cli) ────────────────────────────────────
// Turn on with `DEBUG_STDOUT=1`. Writes to <cwd>/stdout-debug.log —
// project-root rather than ~/.x-code so a single tail -f in the repo
// captures everything. Intentionally sync I/O because callers are in hot
// paths (every stream chunk, every tool call) and we want ordering to
// match real-time events; an async queue would reorder entries.
//
// Content is logged **verbatim**, no truncation. This file is gitignored.
const DEBUG = process.env.DEBUG_STDOUT === '1'

function debugLogPath(): string {
  return path.join(process.cwd(), 'stdout-debug.log')
}

export function debugLog(tag: string, content: string): void {
  if (!DEBUG) return
  try {
    const ts = new Date().toISOString()
    // `JSON.stringify(content)` quotes newlines/tabs so the full payload
    // lands on ONE line in the log — much easier to grep across turns,
    // and multi-line text-deltas don't visually merge with neighbours.
    const line = `[${ts}] ${tag} ${JSON.stringify(content)}\n`
    fsSync.appendFileSync(debugLogPath(), line, 'utf8')
  } catch {
    // best effort — never crash the agent just because we can't log
  }
}

/** Check if a file exists */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/** Read a file safely, return empty string on error */
export async function readFileSafe(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8')
  } catch {
    return ''
  }
}

/** Read and parse a JSON file, return null on error */
export async function readJsonSafe(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(content) as Record<string, unknown>
  } catch {
    return null
  }
}
