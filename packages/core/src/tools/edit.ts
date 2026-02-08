// @x-code/core — edit tool (precise string replacement, no execute — needs permission check)

import { tool } from 'ai'
import { z } from 'zod'

export const edit = tool({
  description:
    'Replace a specific string in a file. The old_string must be unique in the file. Preferred over writeFile for modifications — safer and costs fewer tokens.',
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    oldString: z.string().describe('The exact text to find and replace (must be unique in the file)'),
    newString: z.string().describe('The replacement text'),
    replaceAll: z.boolean().optional().describe('Replace all occurrences (default: false)'),
  }),
  // No execute — handled manually in agent loop for permission check
})
