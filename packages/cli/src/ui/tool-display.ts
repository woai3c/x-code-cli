// @x-code-cli/cli — Shared tool display utilities
//
// Provides human-readable labels, input previews, and result summaries
// for tool calls. Used by both MessageList (Static history) and ToolCall
// (live in-progress indicator).
//
// Tool name matching is case-insensitive to handle model/provider
// variations (e.g. "listDir" vs "ListDir", "readFile" vs "Read").

/** Normalize tool name to lowercase for matching */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, '')
}

/** Map tool name → human-readable label for display */
export function getToolLabel(toolName: string): string {
  const n = normalizeName(toolName)
  if (n === 'shell' || n === 'bash') return 'Bash'
  if (n === 'readfile' || n === 'read') return 'Read'
  if (n === 'writefile' || n === 'write') return 'Write'
  if (n === 'edit' || n === 'update') return 'Update'
  if (n === 'glob') return 'Glob'
  if (n === 'grep' || n === 'search') return 'Grep'
  if (n === 'listdir' || n === 'ls') return 'ListDir'
  if (n === 'websearch') return 'WebSearch'
  if (n === 'webfetch') return 'WebFetch'
  if (n === 'askuser') return 'AskUser'
  if (n === 'saveknowledge') return 'SaveKnowledge'
  if (n === 'enterplanmode') return 'EnterPlanMode'
  if (n === 'exitplanmode') return 'ExitPlanMode'
  return toolName
}

/**
 * Extract the most relevant input preview for a tool call.
 * Tries to find a file path, pattern, command, or query — never falls
 * back to JSON.stringify (which produces escaped backslashes on Windows).
 */
export function getToolInputPreview(toolName: string, input: Record<string, unknown>): string {
  const n = normalizeName(toolName)

  // Shell / Bash — show the command
  if (n === 'shell' || n === 'bash') {
    return (input.command as string) || ''
  }

  // File operations — show the file path
  if (n === 'readfile' || n === 'read' || n === 'writefile' || n === 'write' || n === 'edit' || n === 'update') {
    return (input.filePath as string) || (input.file_path as string) || (input.path as string) || ''
  }

  // Directory listing
  if (n === 'listdir' || n === 'ls') {
    return (input.dirPath as string) || (input.dir_path as string) || (input.path as string) || ''
  }

  // Pattern-based tools
  if (n === 'glob' || n === 'grep' || n === 'search') {
    return (input.pattern as string) || (input.query as string) || ''
  }

  // Web tools
  if (n === 'websearch' || n === 'webfetch') {
    return (input.query as string) || (input.url as string) || ''
  }

  // Generic: try common parameter names before falling back
  for (const key of ['filePath', 'file_path', 'path', 'dirPath', 'dir_path', 'command', 'pattern', 'query', 'url']) {
    if (typeof input[key] === 'string' && input[key]) {
      return input[key] as string
    }
  }

  // Last resort: show first string value (NOT JSON.stringify)
  for (const val of Object.values(input)) {
    if (typeof val === 'string' && val.length <= 100) return val
  }

  return ''
}

/** Generate a short result summary for a completed tool call */
export function getToolResultSummary(
  toolName: string,
  output: string | undefined,
  status: string,
): string | null {
  if (status === 'denied') return 'Denied by user'
  if (!output) return 'Done'

  const n = normalizeName(toolName)

  if (n === 'writefile' || n === 'write') {
    const lineCount = (output.match(/\n/g) || []).length + 1
    return `Wrote ${lineCount} lines`
  }

  if (n === 'edit' || n === 'update') {
    return 'Applied changes'
  }

  if (n === 'readfile' || n === 'read') {
    const lineCount = (output.match(/\n/g) || []).length + 1
    return `${lineCount} lines`
  }

  if (n === 'listdir' || n === 'ls') {
    const entries = output.trim().split('\n').filter((l) => l.trim())
    return entries.length <= 6
      ? entries.join('\n')
      : entries.slice(0, 3).join('\n') + `\n... +${entries.length - 3} items`
  }

  if (n === 'glob') {
    const files = output.trim().split('\n').filter((l) => l.trim())
    return `${files.length} file${files.length !== 1 ? 's' : ''} matched`
  }

  if (n === 'grep' || n === 'search') {
    const lines = output.trim().split('\n').filter((l) => l.trim())
    return `${lines.length} result${lines.length !== 1 ? 's' : ''}`
  }

  if (n === 'shell' || n === 'bash') {
    const lines = output.trim().split('\n').filter((l) => l.trim())
    if (lines.length === 0) return 'Done'
    if (lines.length <= 4) return lines.join('\n')
    return lines.slice(0, 3).join('\n') + `\n... +${lines.length - 3} lines`
  }

  // Generic: show first few lines
  const lines = output.trim().split('\n').filter((l) => l.trim())
  if (lines.length === 0) return 'Done'
  if (lines.length <= 3) return lines.join('\n')
  return lines.slice(0, 2).join('\n') + `\n... +${lines.length - 2} lines`
}
