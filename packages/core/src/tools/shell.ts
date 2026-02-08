// @x-code/core — shell tool (cross-platform command execution, no execute — needs permission check)

import { tool } from 'ai'
import { z } from 'zod'

export const shell = tool({
  description:
    'Execute a shell command and return stdout/stderr. Commands should be compatible with the current platform shell.',
  inputSchema: z.object({
    command: z.string().describe('The command to execute'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 30000)'),
  }),
  // No execute — handled manually in agent loop for permission check + cross-platform shell + streaming
})
