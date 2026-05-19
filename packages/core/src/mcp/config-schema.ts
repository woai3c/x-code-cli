// @x-code-cli/core — MCP config Zod schema
//
// Validates the `mcpServers` field of ~/.x-code/config.json (and the
// project-level .x-code/config.json). One schema covers both stdio and
// streamable-http servers; the union discriminator is field presence:
// `command` → stdio, `url` → http. Configs that have neither (or both)
// are rejected before we try to spawn anything.
import { z } from 'zod'

import type { McpServerConfig } from './types.js'

/** Single permissive schema covering both transports. Field presence
 *  (`command` vs `url`) is the discriminator, enforced via superRefine
 *  rather than z.union — union's per-variant validation hides our
 *  "exactly one of" rule when neither field is present (Zod just says
 *  "Invalid input" because no variant matched). With one flat schema
 *  + superRefine we get readable error messages for every misshape. */
const serverSchema = z
  .object({
    command: z.string().min(1).optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
    url: z.string().url().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    timeout: z.number().int().positive().optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    const hasCommand = typeof v.command === 'string'
    const hasUrl = typeof v.url === 'string'
    if (hasCommand && hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mcpServers entry has both `command` and `url` — set only one',
      })
    }
    if (!hasCommand && !hasUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'mcpServers entry must set either `command` (stdio) or `url` (http)',
      })
    }
    // Cross-field validation: HTTP-only fields with stdio config, and
    // vice versa. Not strictly required (extra fields are ignored at
    // runtime) but the error message catches typos early.
    if (hasCommand && typeof v.headers !== 'undefined') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`headers` is only valid for HTTP servers' })
    }
    if (hasUrl && (v.args || v.env || v.cwd)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`args`/`env`/`cwd` are only valid for stdio servers' })
    }
  })

export const mcpServersSchema = z.record(z.string().min(1), serverSchema)

/** Validate a single server config; throw with a context-tagged message
 *  if it fails. Server name is included so the error tells the user which
 *  entry in their config.json is broken. */
export function parseServerConfig(name: string, raw: unknown): McpServerConfig {
  const result = serverSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((i) => i.message).join('; ')
    throw new Error(`mcpServers.${name}: ${issues}`)
  }
  return result.data as McpServerConfig
}

/** Validate the entire `mcpServers` block. Returns a partial result:
 *  every entry that parsed cleanly is included; broken ones surface in
 *  `errors` so the loader can mark them `failed` without aborting the
 *  whole config. */
export function parseServersBlock(raw: unknown): {
  servers: Record<string, McpServerConfig>
  errors: Array<{ name: string; message: string }>
} {
  const servers: Record<string, McpServerConfig> = {}
  const errors: Array<{ name: string; message: string }> = []

  if (raw === undefined || raw === null) return { servers, errors }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    errors.push({ name: '(root)', message: 'mcpServers must be an object' })
    return { servers, errors }
  }

  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    try {
      servers[name] = parseServerConfig(name, entry)
    } catch (err) {
      errors.push({ name, message: err instanceof Error ? err.message : String(err) })
    }
  }

  return { servers, errors }
}
