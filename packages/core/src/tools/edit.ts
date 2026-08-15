// @x-code-cli/core — edit tool (precise string replacement, no execute — needs permission check)
import { tool } from 'ai'

import { z } from 'zod'

import { MAX_BATCH_EDITS } from './edit-apply.js'

const replacementSchema = z.object({
  oldString: z.string().describe('Exact non-empty text that must occur once in the original file'),
  newString: z.string().describe('Replacement text'),
})

export const edit = tool({
  description:
    'Apply exact replacements to a file after reading it. Preserve exact whitespace and omit readFile line-number prefixes. Batch independent replacements in edits; each oldString must be unique unless replaceAll is true.',
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    edits: z
      .union([z.array(replacementSchema).min(1).max(MAX_BATCH_EDITS), z.string()])
      .optional()
      .describe('Atomic replacements, preferably an array; JSON-encoded arrays are accepted for compatibility'),
    oldString: z.string().optional().describe('Legacy exact text to find and replace'),
    newString: z.string().optional().describe('Legacy replacement text'),
    replaceAll: z.boolean().optional().describe('Replace all occurrences (default: false)'),
  }),
  // No execute — handled manually in agent loop for permission check
})
