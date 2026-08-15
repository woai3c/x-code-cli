// @x-code-cli/core — writeFile tool (no execute — needs permission check in agent loop)
import { tool } from 'ai'

import { z } from 'zod'

export const writeFile = tool({
  description:
    'Create or completely overwrite a local file. Read an existing file first, prefer edit for targeted changes, and do not create documentation unless the user requested it.',
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    content: z.string().describe('The full content to write'),
  }),
  // No execute — handled manually in agent loop for permission check
})
