// @x-code/core — glob tool (file search by pattern)
import { globby } from 'globby'

import { tool } from 'ai'

import { z } from 'zod'

export const glob = tool({
  description: 'Find files matching a glob pattern. Returns file paths sorted by modification time.',
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")'),
    cwd: z.string().optional().describe('Directory to search in (defaults to working directory)'),
  }),
  execute: async ({ pattern, cwd }) => {
    try {
      const files = await globby(pattern, {
        cwd: cwd ?? process.cwd(),
        gitignore: true,
        absolute: true,
      })
      if (files.length === 0) return 'No files found matching the pattern.'
      return files.join('\n')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error searching files: ${msg}`
    }
  },
})
