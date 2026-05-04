// @x-code-cli/core — edit tool (precise string replacement, no execute — needs permission check)
import { tool } from 'ai'

import { z } from 'zod'

export const edit = tool({
  description: `Perform exact string replacements in files.

Usage:
- You must use readFile at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.
- When editing text from readFile output, ensure you preserve the exact indentation (tabs/spaces) as it appears in the file content. Never include line number prefixes in oldString or newString.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- The edit will FAIL if oldString is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use replaceAll to change every instance.
- Use replaceAll for replacing and renaming strings across the file (e.g. renaming a variable).`,
  inputSchema: z.object({
    filePath: z.string().describe('Absolute path to the file'),
    oldString: z.string().describe('The exact text to find and replace (must be unique in the file)'),
    newString: z.string().describe('The replacement text'),
    replaceAll: z.boolean().optional().describe('Replace all occurrences (default: false)'),
  }),
  // No execute — handled manually in agent loop for permission check
})
