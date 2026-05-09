// @x-code-cli/core — glob tool (file search by pattern, via ripgrep)
//
// We delegate the actual file walk to ripgrep (`rg --files --glob ...`)
// rather than using a Node glob library. Three reasons:
//   1. ripgrep is already a dependency for the `grep` tool — reusing it
//      keeps the cross-tool footprint small.
//   2. ripgrep walks gigantic trees fast (Rust + parallel directory walk)
//      and respects .gitignore by default.
//   3. ripgrep's `--sortr=modified` gives us deterministic
//      most-recent-first ordering, which is what the model needs when
//      results are truncated: the most relevant files survive the cap.
//
// This brings glob's actual behavior in line with its description string,
// which previously promised mtime ordering but resolved to library-default
// ordering (alphabetical via globby).
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

import { tool } from 'ai'

import { z } from 'zod'

import { formatToolError } from '../utils/tool-errors.js'
import { reportProgress } from './progress.js'
import { getRipgrepPath } from './utils.js'

const execFileAsync = promisify(execFile)

const MAX_GLOB_RESULTS = 200
const RG_MAX_BUFFER = 20 * 1024 * 1024

export const glob = tool({
  description:
    `Find files matching a glob pattern. Returns absolute file paths sorted by modification time, most recent first. ` +
    `Results are capped at ${MAX_GLOB_RESULTS} files — use a more specific pattern if truncated.`,
  inputSchema: z.object({
    pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.tsx")'),
    cwd: z.string().optional().describe('Directory to search in (defaults to working directory)'),
  }),
  execute: async ({ pattern, cwd }, { toolCallId }) => {
    try {
      const searchDir = cwd ?? process.cwd()
      reportProgress(toolCallId, `Matching ${pattern}`)
      // ripgrep flags:
      //   --files          — list files instead of searching content
      //   --sortr=modified — sort by mtime, most recent first
      //   --hidden         — include dotfiles like .eslintrc / .prettierrc
      //   --glob '!.git'   — explicitly exclude the git metadata directory.
      //                      .gitignore typically does NOT list .git/ (git
      //                      manages it internally), so without this flag
      //                      `--hidden` would happily walk into .git/objects
      //                      and surface thousands of internal hash files.
      //   --glob <pattern> — user's glob filter (relative to search dir)
      //
      // Two patterns get special handling because they interact badly with
      // ripgrep's whitelist-style --glob semantics:
      //
      //   • Catch-all patterns ("**/*", "**", "*") get dropped: a
      //     `--glob "**/*"` is read as an explicit whitelist that overrides
      //     .gitignore, so the result includes node_modules / dist / etc.
      //     — typically tens of thousands of files of pure noise. We drop
      //     the user's --glob entirely so ripgrep's default file walk
      //     applies (which honors .gitignore).
      const isCatchAll = /^(\*\*\/?\*?|\*)$/.test(pattern.trim())
      const args = ['--files', '--sortr=modified', '--hidden', '--glob', '!.git']
      if (!isCatchAll) {
        args.push('--glob', pattern)
      }
      const { stdout } = await execFileAsync(getRipgrepPath(), args, {
        cwd: searchDir,
        maxBuffer: RG_MAX_BUFFER,
        timeout: 30000,
      })
      const out = stdout.trim()
      if (!out) return 'No files found matching the pattern.'
      const relatives = out.split('\n')
      const absolutes = relatives.map((p) => (path.isAbsolute(p) ? p : path.join(searchDir, p)))
      const truncated = absolutes.length > MAX_GLOB_RESULTS
      const result = absolutes.slice(0, MAX_GLOB_RESULTS).join('\n')
      if (truncated) {
        return `${result}\n\n... [${absolutes.length - MAX_GLOB_RESULTS} more files not shown — ${absolutes.length} total matches, capped at ${MAX_GLOB_RESULTS}. Use a more specific pattern to narrow results.]`
      }
      return result
    } catch (err) {
      // ripgrep exits with code 1 when no files match — surface as empty
      // result instead of an error so the model treats "no matches" as a
      // normal outcome rather than a tool failure to retry.
      if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
        return 'No files found matching the pattern.'
      }
      return formatToolError('searching files', err)
    }
  },
})
