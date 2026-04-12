// @x-code-cli/core — Shared utilities and constants
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Project-local config directory name */
export const XCODE_DIR = '.x-code'

/** Global config directory (~/.x-code) */
export const GLOBAL_XCODE_DIR = path.join(os.homedir(), '.x-code')

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
