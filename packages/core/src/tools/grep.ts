// @x-code-cli/core — grep tool (content search via ripgrep)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { getRipgrepPath } from './utils.js'

const execFileAsync = promisify(execFile)

const DEFAULT_HEAD_LIMIT = 250
const MAX_HEAD_LIMIT = 2_000
const MAX_CONTEXT_LINES = 100
const MAX_COLUMNS = 500
const RG_MAX_BUFFER = 4 * 1024 * 1024

export const grep = tool({
  description: `Regex content search built on ripgrep (escape literal braces in regexes, e.g. interface\\{\\}).

- Filter files via glob ("*.{ts,tsx}") or type ("ts", "py", "rust").
- outputMode: "content" (default, line-numbered matches + optional context), "files_with_matches" (paths only), or "count" (matches per file).
- Capped at headLimit lines (default ${DEFAULT_HEAD_LIMIT}); lines longer than ${MAX_COLUMNS} chars are preview-truncated.`,
  inputSchema: z.object({
    pattern: z.string().min(1).max(16_384).describe('Regex pattern to search for'),
    path: z.string().max(4096).optional().describe('File or directory to search in (defaults to working directory)'),
    glob: z.string().max(4096).optional().describe('Glob pattern to filter files (e.g. "*.ts", "*.{ts,tsx}")'),
    type: z.string().max(64).optional().describe('Filter by file type (ripgrep --type, e.g. "ts", "js", "py")'),
    outputMode: z
      .enum(['content', 'files_with_matches', 'count'])
      .optional()
      .describe('What to return (default: "content")'),
    caseInsensitive: z.boolean().optional().describe('Case-insensitive search (ripgrep -i)'),
    linesBefore: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional().describe('Lines before each match'),
    linesAfter: z.number().int().min(0).max(MAX_CONTEXT_LINES).optional().describe('Lines after each match'),
    context: z
      .number()
      .int()
      .min(0)
      .max(MAX_CONTEXT_LINES)
      .optional()
      .describe(
        'Lines of context both before AND after each match (content mode only; ripgrep -C; overrides linesBefore/linesAfter)',
      ),
    multiline: z
      .boolean()
      .optional()
      .describe('Allow a match to span multiple lines, with "." matching newlines (ripgrep -U --multiline-dotall)'),
    headLimit: z
      .number()
      .int()
      .min(1)
      .max(MAX_HEAD_LIMIT)
      .optional()
      .describe(`Max number of output lines (default: ${DEFAULT_HEAD_LIMIT}, max: ${MAX_HEAD_LIMIT})`),
  }),
  execute: async (
    {
      pattern,
      path: searchPath,
      glob: globPattern,
      type,
      outputMode,
      caseInsensitive,
      linesBefore,
      linesAfter,
      context,
      multiline,
      headLimit,
    },
    { toolCallId, abortSignal },
  ) => {
    try {
      const rgPath = getRipgrepPath()
      const limit = Math.min(MAX_HEAD_LIMIT, Math.max(1, headLimit ?? DEFAULT_HEAD_LIMIT))
      const mode = outputMode ?? 'content'

      const args: string[] = ['--color', 'never']

      if (mode === 'files_with_matches') {
        args.push('--files-with-matches')
      } else if (mode === 'count') {
        // --count emits one `path:N` line per matching file (N = matching lines).
        args.push('--count')
      } else {
        // content mode — line-numbered matches, long lines previewed not dumped.
        args.push('--no-heading', '--line-number', '--max-columns', String(MAX_COLUMNS), '--max-columns-preview')
        // Context flags only make sense for content output. -C wins over -A/-B,
        // matching ripgrep's own precedence.
        if (context != null) {
          args.push('--context', String(context))
        } else {
          if (linesBefore != null) args.push('--before-context', String(linesBefore))
          if (linesAfter != null) args.push('--after-context', String(linesAfter))
        }
      }

      if (caseInsensitive) args.push('--ignore-case')
      // ripgrep needs both flags for ". matches newline across lines": -U enables
      // multiline, --multiline-dotall makes `.` cross line boundaries.
      if (multiline) args.push('--multiline', '--multiline-dotall')
      if (type) args.push('--type', type)
      if (globPattern) args.push('--glob', globPattern)

      args.push(pattern)
      args.push(searchPath ?? process.cwd())

      reportProgress(toolCallId, `Searching for /${pattern}/`)
      const { stdout } = await execFileAsync(rgPath, args, {
        maxBuffer: RG_MAX_BUFFER,
        timeout: 30000,
        signal: abortSignal,
        windowsHide: true,
      })
      const out = stdout.trim()
      if (!out) return 'No matches found.'

      const lines = out.split('\n')
      if (lines.length <= limit) return out
      const truncated = lines.slice(0, limit).join('\n')
      const noun = mode === 'files_with_matches' ? 'files' : mode === 'count' ? 'files' : 'lines'
      return `${truncated}\n\n... [${lines.length - limit} more ${noun} not shown — ${lines.length} total, capped at ${limit}. Narrow your pattern, add a glob/type filter, or raise headLimit.]`
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
        return 'No matches found.'
      }
      return formatToolError('searching', err)
    }
  },
})
