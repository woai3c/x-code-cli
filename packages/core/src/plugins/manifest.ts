// @x-code-cli/core — Plugin manifest discovery + zod validation
//
// One job: given a plugin root directory on disk, find its manifest
// (probing the three accepted relative paths in priority order), parse +
// validate the JSON, and return a `PluginManifest`. The caller resolves
// contribution paths and figures out scope / enable state.
//
// Unknown top-level fields in the manifest are silently stripped (zod's
// default behaviour with `z.object`). This is intentional: it lets newer
// Claude Code manifests with fields we don't understand (e.g.
// `output-styles`, `lspServers`) still parse — we just don't act on them.
// `/plugin doctor` later surfaces them as "loaded but contributing X
// unsupported fields" so users know they're getting partial behaviour.
import fs from 'node:fs/promises'
import path from 'node:path'

import { z } from 'zod'

import { GEMINI_MANIFEST_REL, MANIFEST_CANDIDATES } from './paths.js'
import type { ManifestFormat, PluginManifest } from './types.js'

// ── Zod schemas ─────────────────────────────────────────────────────────

const authorSchema = z.union([
  z.string(),
  z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    url: z.string().optional(),
  }),
])

const userConfigItemSchema = z.object({
  key: z.string().min(1),
  type: z.enum(['string', 'number', 'boolean']),
  sensitive: z.boolean().optional(),
  prompt: z.string().optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  description: z.string().optional(),
})

/** Some contribution fields accept either a relative path (string) OR an
 *  inline object — Claude Code's `mcpServers` and `hooks` work this way.
 *  We don't validate the inline object's shape here; that's the job of
 *  the mcp / hooks subsystems, which already own their own schemas. */
const pathOrInline = z.union([z.string().min(1), z.record(z.string(), z.unknown())])

/** Plugin name: lowercase letters, digits, dashes; must start with a
 *  letter or digit. Matches Claude Code / Codex / Gemini and keeps names
 *  safe to use as filesystem path components on Windows. */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const manifestSchema = z.object({
  schemaVersion: z.string().optional(),
  name: z
    .string()
    .min(1)
    .regex(NAME_RE, 'name must be lowercase letters, digits, and dashes only (e.g. "linear-issues")'),
  // version is optional in real Claude Code plugins (verified against
  // anthropics/claude-plugins-official — many ship without one,
  // including major third-party plugins like amplitude). We default
  // to "0.0.0" so cache paths and the installed_plugins.json record
  // still have a usable string.
  version: z.string().min(1).optional(),
  description: z.string().optional(),
  author: authorSchema.optional(),
  keywords: z.array(z.string()).optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),

  skills: z.string().min(1).optional(),
  agents: z.string().min(1).optional(),
  commands: z.string().min(1).optional(),
  mcpServers: pathOrInline.optional(),
  hooks: pathOrInline.optional(),

  userConfig: z.array(userConfigItemSchema).optional(),
  dependencies: z.array(z.string().min(1)).optional(),
  engines: z.object({ 'x-code': z.string().optional() }).optional(),
})

// ── Discovery ───────────────────────────────────────────────────────────

export interface ManifestDiscovery {
  /** Absolute path to the manifest file. */
  manifestPath: string
  format: ManifestFormat
}

/** Probe a plugin root for a manifest. Returns the highest-priority
 *  match. Returns `{ format: 'gemini', ... }` when ONLY a Gemini manifest
 *  exists — the installer uses this to produce a friendly "we don't
 *  support Gemini extensions" error rather than a confusing
 *  "no manifest found". */
export async function discoverManifest(rootDir: string): Promise<ManifestDiscovery | null> {
  for (const candidate of MANIFEST_CANDIDATES) {
    const full = path.join(rootDir, candidate.rel)
    if (await fileExists(full)) {
      return { manifestPath: full, format: candidate.format }
    }
  }
  const gemini = path.join(rootDir, GEMINI_MANIFEST_REL)
  if (await fileExists(gemini)) {
    return { manifestPath: gemini, format: 'gemini' }
  }
  return null
}

// ── Parsing ─────────────────────────────────────────────────────────────

export class ManifestParseError extends Error {
  constructor(
    message: string,
    public readonly manifestPath: string,
  ) {
    super(message)
    this.name = 'ManifestParseError'
  }
}

/** Parse + validate a manifest JSON file. Fills in `schemaVersion: "1"`
 *  when absent (the implicit default — most existing Claude Code plugins
 *  don't set this field). Throws `ManifestParseError` with a path-tagged
 *  message on failure so the loader can collect it as a doctor entry
 *  without aborting the whole boot. */
export async function parseManifest(manifestPath: string): Promise<PluginManifest> {
  let raw: string
  try {
    raw = await fs.readFile(manifestPath, 'utf-8')
  } catch (err) {
    throw new ManifestParseError(
      `failed to read manifest: ${err instanceof Error ? err.message : String(err)}`,
      manifestPath,
    )
  }

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new ManifestParseError(
      `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      manifestPath,
    )
  }

  const result = manifestSchema.safeParse(json)
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')
    throw new ManifestParseError(`invalid manifest — ${issues}`, manifestPath)
  }

  const data = result.data
  return {
    ...data,
    schemaVersion: data.schemaVersion ?? '1',
    version: data.version ?? '0.0.0',
    // Normalise the author union — internal callers only deal with the
    // object form. String authors are turned into `{ name: <string> }`.
    author: typeof data.author === 'string' ? { name: data.author } : data.author,
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}
