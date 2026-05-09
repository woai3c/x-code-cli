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
const MAX_COLUMNS = 500
const RG_MAX_BUFFER = 20 * 1024 * 1024

export const grep = tool({
  description: `A powerful search tool built on ripgrep.

Usage:
- ALWAYS use this grep tool for content search tasks. NEVER invoke grep or rg as a shell command — this tool has been optimized for correct permissions and access.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+").
- Filter files with glob parameter (e.g., "*.ts", "*.{ts,tsx}").
- Pattern syntax: Uses ripgrep — literal braces need escaping (use interface\\{\\} to find interface{} in Go code).
- Results are capped at headLimit lines (default ${DEFAULT_HEAD_LIMIT}). Long lines are truncated at ${MAX_COLUMNS} chars.`,
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().optional().describe('File or directory to search in (defaults to working directory)'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts", "*.{ts,tsx}")'),
    headLimit: z.number().optional().describe(`Max number of output lines (default: ${DEFAULT_HEAD_LIMIT})`),
  }),
  execute: async ({ pattern, path: searchPath, glob: globPattern, headLimit }, { toolCallId }) => {
    try {
      const rgPath = getRipgrepPath()
      const limit = headLimit ?? DEFAULT_HEAD_LIMIT
      const args = [
        '--no-heading',
        '--line-number',
        '--color',
        'never',
        '--max-columns',
        String(MAX_COLUMNS),
        '--max-columns-preview',
      ]
      if (globPattern) {
        args.push('--glob', globPattern)
      }
      args.push(pattern)
      args.push(searchPath ?? process.cwd())

      reportProgress(toolCallId, `Searching for /${pattern}/`)
      const { stdout } = await execFileAsync(rgPath, args, {
        maxBuffer: RG_MAX_BUFFER,
        timeout: 30000,
      })
      const out = stdout.trim()
      if (!out) return 'No matches found.'

      const lines = out.split('\n')
      if (lines.length <= limit) return out
      const truncated = lines.slice(0, limit).join('\n')
      return `${truncated}\n\n... [${lines.length - limit} more lines not shown — at least ${lines.length} total matches, capped at ${limit}. Narrow your pattern or use glob to reduce results.]`
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
        return 'No matches found.'
      }
      return formatToolError('searching', err)
    }
  },
})
