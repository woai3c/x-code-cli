import fs from 'node:fs/promises'
import path from 'node:path'

import { XCODE_DIR } from './utils.js'

const GITIGNORE_ENTRY = '.x-code'
const GITIGNORE_COMMENT = '\n# X-Code CLI project-local state (sessions, history, plans, memory, and local settings)'

function alreadyIgnoresXcode(content: string): boolean {
  return content.split(/\r?\n/).some((line) => {
    const rule = line.trim()
    return rule === '.x-code' || rule === '.x-code/' || rule === '/.x-code' || rule === '/.x-code/'
  })
}

async function appendXcodeToGitignore(cwd: string): Promise<void> {
  const gitignorePath = path.join(cwd, '.gitignore')
  try {
    const content = await fs.readFile(gitignorePath, 'utf-8')
    if (alreadyIgnoresXcode(content)) return

    const newline = content.includes('\r\n') ? '\r\n' : '\n'
    const prefix = content.length > 0 && !content.endsWith('\n') && !content.endsWith('\r') ? newline : ''
    await fs.appendFile(gitignorePath, `${prefix}${GITIGNORE_COMMENT}${newline}${GITIGNORE_ENTRY}${newline}`, 'utf-8')
  } catch {
    // A missing or unwritable .gitignore is non-fatal; never create one implicitly.
  }
}

/** Create an existing project-storage path and update .gitignore only when
 * this mkdir operation created the top-level .x-code directory. */
export async function ensureProjectStorageDir(directory: string): Promise<void> {
  try {
    const createdDir = await fs.mkdir(directory, { recursive: true })
    if (createdDir !== undefined && path.basename(createdDir) === XCODE_DIR) {
      await appendXcodeToGitignore(path.dirname(createdDir))
    }
  } catch {
    // Project persistence is best-effort and must never prevent the CLI from running.
  }
}
