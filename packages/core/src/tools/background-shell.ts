import { tool } from 'ai'

import { z } from 'zod'

import { createCompatibleInputSchema } from './schema-compat.js'

const shellOutputPublicSchema = z.object({
  shellId: z.string().describe('The opaque background shell id returned by shell.'),
  chars: z.string().optional().describe('Terminal input for a PTY session. Omit or use an empty string to only wait.'),
  cols: z.number().int().positive().max(1_000).optional().describe('New PTY width; requires rows.'),
  rows: z.number().int().positive().max(1_000).optional().describe('New PTY height; requires cols.'),
  yieldTimeMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Wait window in milliseconds (default: 5000; 0: immediate).'),
  maxOutputTokens: z.number().int().positive().optional().describe('Optional model-facing output budget in tokens.'),
})

const shellOutputRuntimeSchema = shellOutputPublicSchema.extend({
  block: z.boolean().optional(),
  timeout: z.number().int().nonnegative().optional(),
})

export const shellOutput = tool({
  description: `Read incremental output from a background shell session and interact with PTY sessions.

- Returns output produced since the previous read plus running/exit status; waits up to 5s by default (set yieldTimeMs: 0 for immediate read).
- For tty: true sessions, chars sends terminal input (\\u0003 for Ctrl+C); cols and rows resize the PTY together.
- For non-TTY sessions, \\u0003 terminates the process tree; other non-empty chars are rejected.
- Truncated transcripts spill to a temp log path readable via readFile.`,
  inputSchema: createCompatibleInputSchema(shellOutputPublicSchema, shellOutputRuntimeSchema),
  // Session-aware execution is routed through tool-execution.ts.
})

export const killShell = tool({
  description: `Terminate a managed background shell and confirm whether its complete process tree exited.`,
  inputSchema: z.object({
    shellId: z.string().describe('The opaque background shell id returned by shell.'),
  }),
  // Session-aware execution is routed through tool-execution.ts.
})
