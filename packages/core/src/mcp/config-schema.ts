// @x-code-cli/core — MCP config Zod schema
//
// Validates the `mcpServers` field of ~/.x-code/config.json (and the
// project-level .x-code/config.json). One schema covers both stdio and
// streamable-http servers; the union discriminator is field presence:
// `command` → stdio, `url` → http. Configs that have neither (or both)
// are rejected before we try to spawn anything.
import { z } from 'zod'

import { errorMessage } from '../utils.js'
import type { McpServerConfig } from './types.js'

/** Single permissive schema covering both transports. Field presence
 *  (`command` vs `url`) is the discriminator, enforced via superRefine
 *  rather than z.union — union's per-variant validation hides our
 *  "exactly one of" rule when neither field is present (Zod just says
 *  "Invalid input" because no variant matched). With one flat schema
 *  + superRefine we get readable error messages for every misshape. */
const serverSchema = z
  .object({
    type: z.enum(['stdio', 'http']).optional(),
    command: z.string().min(1).max(4096).optional(),
    args: z.array(z.string().max(16_384)).max(256).optional(),
    env: z.record(z.string().min(1).max(256), z.string().max(65_536)).optional(),
    cwd: z.string().max(4096).optional(),
    url: z
      .string()
      .url()
      .max(8192)
      .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'MCP URL must use http or https')
      .optional(),
    headers: z.record(z.string().min(1).max(256), z.string().max(16_384)).optional(),
    timeout: z.number().int().positive().max(300_000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
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
    if ((v.type === 'stdio' && !hasCommand) || (v.type === 'http' && !hasUrl)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '`type` does not match the configured MCP transport' })
    }
  })

const MAX_MCP_SERVERS = 128

export const mcpServersSchema = z
  .record(z.string().min(1).max(128), serverSchema)
  .refine(
    (servers) => Object.keys(servers).length <= MAX_MCP_SERVERS,
    `at most ${MAX_MCP_SERVERS} MCP servers are allowed`,
  )

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

  const entries = Object.entries(raw as Record<string, unknown>)
  if (entries.length > MAX_MCP_SERVERS) {
    errors.push({ name: '*', message: `At most ${MAX_MCP_SERVERS} MCP servers are allowed` })
  }
  for (const [name, entry] of entries.slice(0, MAX_MCP_SERVERS)) {
    if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
      errors.push({ name, message: 'MCP server name must be 1-128 characters without control characters' })
      continue
    }
    try {
      servers[name] = parseServerConfig(name, entry)
    } catch (err) {
      errors.push({ name, message: errorMessage(err) })
    }
  }

  return { servers, errors }
}
