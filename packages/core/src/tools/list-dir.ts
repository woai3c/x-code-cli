// @x-code-cli/core — listDir tool
import fs from 'node:fs/promises'

import { tool } from 'ai'

import { z } from 'zod'

import { reportProgress } from './progress.js'

export const listDir = tool({
  description: 'List the contents of a directory. Returns names with type indicators (/ for directories).',
  inputSchema: z.object({
    dirPath: z.string().describe('Absolute path to the directory'),
  }),
  execute: async ({ dirPath }, { toolCallId }) => {
    try {
      reportProgress(toolCallId, `Listing ${dirPath}`)
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      const lines = entries.map((e) => {
        const suffix = e.isDirectory() ? '/' : ''
        return `${e.name}${suffix}`
      })
      return lines.join('\n') || '(empty directory)'
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return `Error listing directory: ${msg}`
    }
  },
})
