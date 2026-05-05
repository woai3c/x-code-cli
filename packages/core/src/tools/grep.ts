// @x-code-cli/core — grep tool (content search via ripgrep)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

const execFileAsync = promisify(execFile)

const DEFAULT_HEAD_LIMIT = 250
const MAX_COLUMNS = 500
const RG_MAX_BUFFER = 20 * 1024 * 1024

let _rgPath: string | null = null

function getRipgrepPath(): string {
  if (_rgPath) return _rgPath
  try {
    // @vscode/ripgrep provides the binary path
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rg = require('@vscode/ripgrep') as { rgPath: string }
    _rgPath = rg.rgPath
  } catch {
    _rgPath = 'rg'
  }
  return _rgPath
}

export const grep = tool({
  description: `A powerful search tool built on ripgrep.

Usage:
- ALWAYS use this grep tool for content search tasks. NEVER invoke grep or rg as a shell command — this tool has been optimized for correct permissions and access.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+").
- Output modes: "files_with_matches" (default — file paths only, cheapest), "content" (matching lines), "count" (per-file counts).
- Filter by file type (e.g. type: "ts") or glob (e.g. glob: "*.{ts,tsx}"). Type is more concise for standard languages.
- Add context lines around each match with contextBefore / contextAfter / context (only meaningful in "content" mode).
- Multiline mode lets the pattern span newlines: enable with multiline: true.
- Hidden files / .git etc are skipped by default — set hidden: true to include them.
- Pattern syntax: Uses ripgrep — literal braces need escaping (use interface\\{\\} to find interface{} in Go code).
- Results are capped at headLimit lines (default ${DEFAULT_HEAD_LIMIT}). Long lines are truncated at ${MAX_COLUMNS} chars. Use offset for pagination past the cap.`,
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().optional().describe('File or directory to search in (defaults to working directory)'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts", "*.{ts,tsx}")'),
    type: z.string().optional().describe('Filter by ripgrep file type (e.g. "ts", "py", "go", "rust")'),
    outputMode: z
      .enum(['files_with_matches', 'content', 'count'])
      .optional()
      .describe(
        'files_with_matches (default) returns file paths only; content returns matching lines; count returns per-file match counts',
      ),
    contextBefore: z.number().optional().describe('Lines of context BEFORE each match (content mode only)'),
    contextAfter: z.number().optional().describe('Lines of context AFTER each match (content mode only)'),
    context: z.number().optional().describe('Lines of context BEFORE and AFTER each match (content mode only)'),
    caseInsensitive: z.boolean().optional().describe('Case-insensitive match'),
    multiline: z.boolean().optional().describe('Enable multiline mode (. matches newlines, patterns can span lines)'),
    hidden: z.boolean().optional().describe('Include hidden files and directories (default: false)'),
    headLimit: z.number().optional().describe(`Max number of output lines (default: ${DEFAULT_HEAD_LIMIT})`),
    offset: z.number().optional().describe('Skip the first N output lines for pagination past headLimit'),
  }),
  execute: async (
    {
      pattern,
      path: searchPath,
      glob: globPattern,
      type,
      outputMode,
      contextBefore,
      contextAfter,
      context,
      caseInsensitive,
      multiline,
      hidden,
      headLimit,
      offset,
    },
    { toolCallId },
  ) => {
    try {
      const rgPath = getRipgrepPath()
      const limit = headLimit ?? DEFAULT_HEAD_LIMIT
      const skip = offset ?? 0
      const mode = outputMode ?? 'files_with_matches'

      const args: string[] = ['--color', 'never']

      if (mode === 'files_with_matches') {
        args.push('--files-with-matches')
      } else if (mode === 'count') {
        // -c: per-file match COUNT (one line per file). --no-heading
        // keeps the path:count format flat across all files.
        args.push('--count', '--no-heading')
      } else {
        // content
        args.push('--no-heading', '--line-number', '--max-columns', String(MAX_COLUMNS), '--max-columns-preview')
        // Context flags only matter in content mode — ripgrep silently
        // ignores them otherwise but we suppress them for clarity.
        if (context != null) args.push('-C', String(context))
        if (contextBefore != null) args.push('-B', String(contextBefore))
        if (contextAfter != null) args.push('-A', String(contextAfter))
      }

      if (caseInsensitive) args.push('-i')
      if (multiline) args.push('-U', '--multiline-dotall')
      if (hidden) args.push('--hidden')
      if (globPattern) args.push('--glob', globPattern)
      if (type) args.push('--type', type)

      // Use -e so patterns starting with `-` aren't interpreted as flags.
      args.push('-e', pattern)
      args.push(searchPath ?? process.cwd())

      reportProgress(toolCallId, `Searching for /${pattern}/ (${mode})`)
      const { stdout } = await execFileAsync(rgPath, args, {
        maxBuffer: RG_MAX_BUFFER,
        timeout: 30000,
      })
      const out = stdout.trim()
      if (!out) return 'No matches found.'

      const allLines = out.split('\n')
      const totalLines = allLines.length
      const sliced = allLines.slice(skip, skip + limit)
      if (sliced.length === 0) {
        return `[Offset ${skip} is past the end of ${totalLines} result lines.]`
      }
      const visible = sliced.join('\n')
      const remainingAfter = totalLines - (skip + sliced.length)
      const skippedBefore = skip
      if (remainingAfter <= 0 && skippedBefore === 0) return visible

      const noteParts: string[] = []
      if (skippedBefore > 0) noteParts.push(`skipped first ${skippedBefore}`)
      if (remainingAfter > 0)
        noteParts.push(
          `${remainingAfter} more not shown — call again with offset=${skip + sliced.length} to continue, or narrow the pattern`,
        )
      return `${visible}\n\n... [${totalLines} total result lines${noteParts.length ? '; ' + noteParts.join('; ') : ''}.]`
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
        return 'No matches found.'
      }
      return formatToolError('searching', err)
    }
  },
})
