// @x-code-cli/core — glob tool (file search by pattern)
import { globby } from 'globby'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'

import { reportProgress } from './progress.js'

const MAX_GLOB_RESULTS = 200

export const glob = tool({
  description:
    `Find files matching a glob pattern. Returns file paths sorted by modification time. ` +
    `Results are capped at ${MAX_GLOB_RESULTS} files — use a more specific pattern if truncated.`,
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")'),
    cwd: z.string().optional().describe('Directory to search in (defaults to working directory)'),
  }),
  execute: async ({ pattern, cwd }, { toolCallId }) => {
    try {
      reportProgress(toolCallId, `Matching ${pattern}`)
      const files = await globby(pattern, {
        cwd: cwd ?? process.cwd(),
        gitignore: true,
        absolute: true,
      })
      if (files.length === 0) return 'No files found matching the pattern.'
      const truncated = files.length > MAX_GLOB_RESULTS
      const result = files.slice(0, MAX_GLOB_RESULTS).join('\n')
      if (truncated) {
        return `${result}\n\n... [${files.length - MAX_GLOB_RESULTS} more files not shown — ${files.length} total matches, capped at ${MAX_GLOB_RESULTS}. Use a more specific pattern to narrow results.]`
      }
      return result
    } catch (err) {
      return formatToolError('searching files', err)
    }
  },
})
