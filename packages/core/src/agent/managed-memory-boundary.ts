import os from 'node:os'
import path from 'node:path'

import { isReadOnly, splitShellCommands } from '../tools/shell-utils.js'

const MEMORY_MUTATING_COMMAND_RE =
  /(?:^|[\s;|&])(?:add-content|copy-item|mkdir|move-item|mv|new-item|out-file|remove-item|rename-item|rm|sed\s+-i|set-content|tee|touch|truncate)\b/i

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\\/g, '/').toLowerCase()
}

function isPathInside(filePath: string, root: string): boolean {
  const file = normalizePath(filePath)
  const directory = normalizePath(root)
  return file === directory || file.startsWith(directory + '/')
}

function shellMemoryMarkers(memoryRoot: string): string[] {
  const markers = new Set([normalizePath(memoryRoot)])
  const relativeToHome = path.relative(os.homedir(), path.resolve(memoryRoot)).replace(/\\/g, '/')
  if (relativeToHome && relativeToHome !== '..' && !relativeToHome.startsWith('../')) {
    const relative = relativeToHome.toLowerCase()
    markers.add(`~/${relative}`)
    markers.add(`$home/${relative}`)
    markers.add(`\${home}/${relative}`)
    markers.add(`%userprofile%/${relative}`)
  }
  if (
    process.env.X_CODE_HOME &&
    normalizePath(path.join(process.env.X_CODE_HOME, 'memory')) === normalizePath(memoryRoot)
  ) {
    markers.add('$x_code_home/memory')
    markers.add('${x_code_home}/memory')
    markers.add('%x_code_home%/memory')
  }
  return [...markers]
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** General agent tools must not bypass the durable memory store's single writer. */
export function isManagedMemoryMutation(
  toolName: string,
  input: Record<string, unknown>,
  memoryRoot: string | undefined,
): boolean {
  if (!memoryRoot) return false
  if (toolName === 'writeFile' || toolName === 'edit') {
    const filePath = typeof input.filePath === 'string' ? input.filePath : ''
    return Boolean(filePath) && isPathInside(filePath, memoryRoot)
  }
  if (toolName !== 'shell') return false

  const command = typeof input.command === 'string' ? input.command : ''
  const normalized = command.replace(/\\/g, '/').toLowerCase()
  const referencedMarkers = shellMemoryMarkers(memoryRoot).filter((marker) => normalized.includes(marker))
  if (referencedMarkers.length === 0) return false
  if (splitShellCommands(command).some((part) => !isReadOnly(part))) return true
  if (MEMORY_MUTATING_COMMAND_RE.test(command)) return true
  return referencedMarkers.some((marker) => new RegExp(`>{1,2}\\s*["']?${regexEscape(marker)}`).test(normalized))
}

/** Memory diagnostics may read managed files without surfacing them as chat content. */
export function isManagedMemoryAccess(
  toolName: string,
  input: Record<string, unknown>,
  memoryRoot: string | undefined,
): boolean {
  if (!memoryRoot) return false
  const pathKeys: Record<string, readonly string[]> = {
    readFile: ['filePath'],
    writeFile: ['filePath'],
    edit: ['filePath'],
    glob: ['cwd'],
    grep: ['path'],
    listDir: ['dirPath'],
  }
  const keys = pathKeys[toolName]
  if (keys?.some((key) => typeof input[key] === 'string' && isPathInside(input[key] as string, memoryRoot))) {
    return true
  }
  if (toolName !== 'shell') return false
  const command = typeof input.command === 'string' ? input.command.replace(/\\/g, '/').toLowerCase() : ''
  return shellMemoryMarkers(memoryRoot).some((marker) => command.includes(marker))
}
