// @x-code-cli/core — glob tool (file search by pattern)
import { globby } from 'globby'

import fs from 'node:fs/promises'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

const MAX_GLOB_RESULTS = 200

export const glob = tool({
  description:
    `Find files matching a glob pattern. Returns file paths sorted by modification time (most recent first). ` +
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

      // Sort by mtime descending (newest first). The tool description has
      // always promised this; previously globby returned filesystem order
      // and the description was a lie. Stat all files in parallel — for
      // 200 files this is one quick I/O burst, dominated by the glob walk
      // itself. Files that fail to stat (race with deletion, permission)
      // get treated as oldest (-Infinity) so they sink to the bottom but
      // still appear in results — model sees them rather than silently
      // dropping.
      const withMtime = await Promise.all(
        files.map(async (f) => {
          try {
            const stat = await fs.stat(f)
            return { f, mtimeMs: stat.mtimeMs }
          } catch {
            return { f, mtimeMs: -Infinity }
          }
        }),
      )
      withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs)
      const sorted = withMtime.map((x) => x.f)

      const truncated = sorted.length > MAX_GLOB_RESULTS
      const result = sorted.slice(0, MAX_GLOB_RESULTS).join('\n')
      if (truncated) {
        return `${result}\n\n... [${sorted.length - MAX_GLOB_RESULTS} more files not shown — ${sorted.length} total matches, capped at ${MAX_GLOB_RESULTS}. Use a more specific pattern to narrow results.]`
      }
      return result
    } catch (err) {
      return formatToolError('searching files', err)
    }
  },
})
