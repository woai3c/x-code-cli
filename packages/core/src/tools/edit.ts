// @x-code-cli/core — edit tool (precise string replacement, no execute — needs permission check)
import { tool } from 'ai'

import { z } from 'zod'

import { MAX_BATCH_EDITS } from './edit-apply.js'
import { createCompatibleInputSchema } from './schema-compat.js'

const replacementSchema = z.object({
  oldString: z.string().describe('Exact non-empty text that must occur once in the original file'),
  newString: z.string().describe('Replacement text'),
})

const editPublicSchema = z.object({
  filePath: z.string().describe('Absolute path to the file'),
  edits: z
    .array(replacementSchema)
    .min(1)
    .max(MAX_BATCH_EDITS)
    .optional()
    .describe('Atomic unique replacements; do not combine with top-level oldString/newString/replaceAll'),
  oldString: z.string().optional().describe('Exact text to replace (single or replaceAll mode)'),
  newString: z.string().optional().describe('Replacement text (single or replaceAll mode)'),
  replaceAll: z.boolean().optional().describe('Replace all occurrences in oldString/newString mode (default: false)'),
})

const editRuntimeSchema = editPublicSchema.extend({
  edits: z.union([z.array(replacementSchema).min(1).max(MAX_BATCH_EDITS), z.string()]).optional(),
})

export const edit = tool({
  description:
    'Apply exact string replacements to a file. Preserve exact whitespace and omit readFile line-number prefixes. Use edits for atomic multi-hunk replacements (each oldString unique), or oldString/newString for a single or replaceAll edit.',
  inputSchema: createCompatibleInputSchema(editPublicSchema, editRuntimeSchema),
  // No execute — handled manually in agent loop for permission check
})
