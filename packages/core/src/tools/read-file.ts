// @x-code/core — readFile tool
import fs from 'node:fs/promises'

import { tool } from 'ai'

import { z } from 'zod'

export const readFile = tool({
  description: 'Read the contents of a file at the given path. Returns the file content with line numbers.',
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    offset: z.number().optional().describe('Start line (1-based)'),
    limit: z.number().optional().describe('Max lines to read'),
  }),
  execute: async ({ filePath, offset, limit }) => {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const lines = content.split('\n')
      const start = (offset ?? 1) - 1
      const end = limit ? start + limit : lines.length
      const sliced = lines.slice(start, end)
      const numbered = sliced.map((line, i) => `${start + i + 1}\t${line}`)
      return numbered.join('\n')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error reading file: ${msg}`
    }
  },
})
