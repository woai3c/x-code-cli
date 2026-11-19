// @x-code-cli/core — shell tool (cross-platform command execution, no execute — needs permission check)
import { tool } from 'ai'

import { z } from 'zod'

import { createCompatibleInputSchema } from './schema-compat.js'

const shellPublicSchema = z.object({
  command: z.string().describe('The command to execute'),
  timeout: z
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .optional()
    .describe('Optional hard runtime limit in milliseconds. Omit for no hard timeout.'),
  yieldTimeMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Initial wait in milliseconds before returning a running shell id (default: 10000; 0: immediate).'),
  cwd: z.string().optional().describe('Working directory, resolved relative to the session project directory.'),
  maxOutputTokens: z.number().int().positive().optional().describe('Optional model-facing output budget in tokens.'),
  tty: z.boolean().optional().describe('Run the command in a PTY/ConPTY so it can accept interactive terminal input.'),
})

const shellRuntimeSchema = shellPublicSchema.extend({
  runInBackground: z.boolean().optional(),
})

export const shell = tool({
  description: `Execute a shell command and return stdout/stderr. Commands still running after yieldTimeMs (default 10s) continue as background shell sessions with an opaque shellId for shellOutput / killShell.

Notes:
- Quote paths containing spaces. Run independent commands in parallel tool calls; chain dependent steps using current-shell syntax.
- Git safety: prefer new commits over amending; never pass --no-verify unless asked; avoid destructive git commands unless explicitly requested.
- Set yieldTimeMs: 0 to background immediately. Set tty: true for interactive programs (drive input via shellOutput chars).
- Truncated output spills to a temp log path readable via readFile with offset/limit.`,
  inputSchema: createCompatibleInputSchema(shellPublicSchema, shellRuntimeSchema),
  // No execute — handled manually in agent loop for permission check + cross-platform shell + streaming
})
