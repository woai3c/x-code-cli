// @x-code-cli/core — edit tool (precise string replacement, no execute — needs permission check)
import { tool } from 'ai'

import { z } from 'zod'

import { MAX_BATCH_EDITS } from './edit-apply.js'

const replacementSchema = z.object({
  oldString: z.string().describe('Exact non-empty text that must occur once in the original file'),
  newString: z.string().describe('Replacement text'),
})

export const edit = tool({
  description: `Perform exact string replacements in files.

Usage:
- You must use readFile at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from readFile output, ensure you preserve the exact indentation (tabs/spaces) as it appears in the file content. Never include line number prefixes in oldString or newString.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- For multiple independent changes in one file, prefer one edits array. Every oldString is matched uniquely against the original file and all replacements are applied atomically.
- The edit will FAIL if oldString is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replaceAll to change every instance.
- Use replaceAll for replacing and renaming strings across the file (e.g. renaming a variable).`,
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
