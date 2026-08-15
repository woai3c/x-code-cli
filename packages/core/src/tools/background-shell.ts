import { tool } from 'ai'

import { z } from 'zod'

export const shellOutput = tool({
  description: `Read new output from a shell session returned by shell, and interact with PTY sessions.

- Returns only output produced since the previous read, plus structured running or exit status.
- By default an empty read waits up to 5 seconds for output or completion without polling.
- For a shell started with tty: true, chars writes terminal input. Use \\u0003 for Ctrl+C.
- For a non-TTY shell, \\u0003 terminates the managed process tree; other non-empty input is rejected.
- cols and rows resize a PTY and must be provided together.
- Set yieldTimeMs: 0 or legacy block: false to read immediately.`,
  inputSchema: z.object({
    shellId: z.string().describe('The opaque background shell id returned by shell.'),
    chars: z
      .string()
      .optional()
      .describe('Terminal input for a PTY session. Omit or use an empty string to only wait.'),
    cols: z.number().int().positive().max(1_000).optional().describe('New PTY width; requires rows.'),
    rows: z.number().int().positive().max(1_000).optional().describe('New PTY height; requires cols.'),
    yieldTimeMs: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Wait window in milliseconds (default: 5000; 0: immediate).'),
    maxOutputTokens: z.number().int().positive().optional().describe('Optional model-facing output budget in tokens.'),
    block: z.boolean().optional().describe('Legacy wait flag. Explicit false reads immediately; true waits.'),
    timeout: z.number().int().nonnegative().optional().describe('Legacy wait duration used with block: true.'),
  }),
  // Session-aware execution is routed through tool-execution.ts.
})

export const killShell = tool({
  description: `Terminate a managed background shell and confirm whether its complete process tree exited.`,
  inputSchema: z.object({
    shellId: z.string().describe('The opaque background shell id returned by shell.'),
  }),
  // Session-aware execution is routed through tool-execution.ts.
})
