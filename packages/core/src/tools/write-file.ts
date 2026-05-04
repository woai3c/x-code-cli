// @x-code-cli/core — writeFile tool (no execute — needs permission check in agent loop)
import { tool } from 'ai'

import { z } from 'zod'

export const writeFile = tool({
  description: `Write a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the readFile tool first to read the file's contents. This tool will fail if you did not read the file first.
- Prefer the edit tool for modifying existing files — it only sends the diff. Only use this tool to create new files or for complete rewrites.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the user.`,
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    content: z.string().describe('The full content to write'),
  }),
  // No execute — handled manually in agent loop for permission check
})
