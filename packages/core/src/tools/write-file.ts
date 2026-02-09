// @x-code/core — writeFile tool (no execute — needs permission check in agent loop)
import { tool } from 'ai'

import { z } from 'zod'

export const writeFile = tool({
  description:
    'Create or overwrite a file at the given path. Always prefer edit (string replacement) over writeFile for modifying existing files.',
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    content: z.string().describe('The full content to write'),
  }),
  // No execute — handled manually in agent loop for permission check
})
