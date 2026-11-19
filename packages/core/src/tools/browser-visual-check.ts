// @x-code-cli/core — One-shot local browser screenshot verification
//
// This is intentionally a single composite tool rather than exposing the
// Playwright MCP surface to the root agent. The dispatch layer opens the local
// page, waits briefly, captures one bounded screenshot, and returns only that
// image plus a compact console-error summary. Navigation snapshots stay outside
// model context.
import { tool } from 'ai'

import { z } from 'zod'

export const BROWSER_VISUAL_CHECK_TOOL_NAME = 'browserVisualCheck'

export const browserVisualCheck = tool({
  description:
    'Capture one current-viewport JPEG screenshot plus console errors from a localhost/loopback HTTP(S) URL in a temporary tab without disturbing existing tabs. Use the browser sub-agent instead when multi-step interaction is required.',
  inputSchema: z.object({
    url: z.string().describe('Local app URL, for example http://localhost:3000/settings or http://127.0.0.1:5173.'),
    waitMs: z
      .number()
      .int()
      .min(0)
      .max(5_000)
      .optional()
      .describe('Extra render-settle delay after navigation in milliseconds (default 500, maximum 5000).'),
    viewport: z
      .object({
        width: z.number().int().min(320).max(1_920),
        height: z.number().int().min(320).max(1_200),
      })
      .optional()
      .describe('Optional viewport override. Omit to use the configured browser viewport.'),
  }),
  // No execute — hand-dispatched in agent/tool-execution.ts so it can share
  // the private browser MCP, forward abortSignal, and return typed image media.
})
