// @x-code-cli/core — writeFile tool (no execute — needs permission check in agent loop)
import { tool } from 'ai'

import { z } from 'zod'

export const writeFile = tool({
  description: 'Create a new file or completely overwrite an existing file (prefer edit for partial changes).',
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    content: z.string().describe('The full content to write'),
  }),
  // No execute — handled manually in agent loop for permission check
})
