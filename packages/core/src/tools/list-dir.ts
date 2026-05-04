// @x-code-cli/core — listDir tool
import fs from 'node:fs/promises'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
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
      return formatToolError('listing directory', err)
    }
  },
})
