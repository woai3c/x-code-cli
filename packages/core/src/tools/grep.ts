// @x-code/core — grep tool (content search via ripgrep)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

const execFileAsync = promisify(execFile)

function getRipgrepPath(): string {
  try {
    // @vscode/ripgrep provides the binary path
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rg = require('@vscode/ripgrep') as { rgPath: string }
    return rg.rgPath
  } catch {
    return 'rg'
  }
}

export const grep = tool({
  description:
    'Search file contents by regex pattern using ripgrep. Returns matching lines with file paths and line numbers.',
  inputSchema: z.object({
    pattern: z.string().describe('Regex pattern to search for'),
    path: z.string().optional().describe('File or directory to search in (defaults to working directory)'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.ts", "*.{ts,tsx}")'),
    maxResults: z.number().optional().describe('Max number of results (default: 50)'),
  }),
  execute: async ({ pattern, path: searchPath, glob: globPattern, maxResults }) => {
    try {
      const rgPath = getRipgrepPath()
      const args = ['--no-heading', '--line-number', '--color', 'never', '--max-count', String(maxResults ?? 50)]
      if (globPattern) {
        args.push('--glob', globPattern)
      }
      args.push(pattern)
      args.push(searchPath ?? process.cwd())

      const { stdout } = await execFileAsync(rgPath, args, {
        maxBuffer: 1024 * 1024,
        timeout: 30000,
      })
      return stdout.trim() || 'No matches found.'
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
        return 'No matches found.'
      }
      const msg = err instanceof Error ? err.message : String(err)
      return `Error searching: ${msg}`
    }
  },
})
