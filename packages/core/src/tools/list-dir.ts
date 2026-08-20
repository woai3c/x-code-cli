// @x-code-cli/core — listDir tool
import fs from 'node:fs/promises'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'

const MAX_DIRECTORY_ENTRIES = 2_000
const MAX_DIRECTORY_OUTPUT_BYTES = 256 * 1024

export const listDir = tool({
  description: 'List the contents of a directory. Returns names with type indicators (/ for directories).',
  inputSchema: z.object({
    dirPath: z.string().min(1).max(4096).describe('Absolute path to the directory'),
  }),
  execute: async ({ dirPath }, { toolCallId, abortSignal }) => {
    try {
      abortSignal?.throwIfAborted()
      reportProgress(toolCallId, `Listing ${dirPath}`)
      const directory = await fs.opendir(dirPath)
      const lines: string[] = []
      let outputBytes = 0
      let truncated = false
      try {
        for await (const entry of directory) {
          abortSignal?.throwIfAborted()
          const line = `${entry.name}${entry.isDirectory() ? '/' : ''}`
          const bytes = Buffer.byteLength(line, 'utf8') + 1
          if (lines.length >= MAX_DIRECTORY_ENTRIES || outputBytes + bytes > MAX_DIRECTORY_OUTPUT_BYTES) {
            truncated = true
            break
          }
          lines.push(line)
          outputBytes += bytes
        }
      } finally {
        await directory.close().catch(() => {})
      }
      if (lines.length === 0) return '(empty directory)'
      if (truncated) {
        lines.push(`... [directory listing capped at ${MAX_DIRECTORY_ENTRIES} entries / 256 KiB]`)
      }
      return lines.join('\n')
    } catch (err) {
      return formatToolError('listing directory', err)
    }
  },
})
