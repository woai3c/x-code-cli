// @x-code-cli/core — Shared minimal YAML frontmatter parser
//
// Used by commands, skills, and sub-agent loaders. Handles the subset
// we need without a dependency on gray-matter: string scalars, number
// scalars, inline/flow arrays, folded continuation lines, quote stripping,
// and comment lines. Each consumer validates the parsed data further with
// Zod or domain-specific logic.

export interface FrontmatterResult {
  data: Record<string, unknown>
  body: string
}

export interface ParseFrontmatterOptions {
  /** When true, parse `[a, b]` as string arrays and digit-only values as
   *  numbers. When false (default), all values remain strings. Sub-agents
   *  need this for `tools: [...]` and `maxTurns: 10`; commands and skills
   *  don't. */
  coerceTypes?: boolean
}

/** Parse a `---` delimited YAML frontmatter block from the start of a
 *  markdown file. Returns null if no valid fence is found.
 *
 *  Supports:
 *  - Indented continuation lines (folded into previous line)
 *  - Inline arrays: `key: [a, b, c]` (when coerceTypes=true)
 *  - Integer scalars: `key: 42` (when coerceTypes=true)
 *  - Quoted string scalars (single or double)
 *  - Comment lines (lines starting with `#`) */
export function parseFrontmatter(raw: string, options?: ParseFrontmatterOptions): FrontmatterResult | null {
  const coerce = options?.coerceTypes ?? false
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]!
  const body = match[2]!
  const data: Record<string, unknown> = {}

  const foldedLines: string[] = []
  for (const line of yamlBlock.split(/\r?\n/)) {
    if (/^\s/.test(line) && line.trim() && foldedLines.length > 0) {
      foldedLines[foldedLines.length - 1] += ' ' + line.trim()
    } else {
      foldedLines.push(line)
    }
  }

  for (const line of foldedLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue

    const colonIdx = trimmed.indexOf(':')
    if (colonIdx < 1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    let value: string | number | string[] = trimmed.slice(colonIdx + 1).trim()

    if (coerce && value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1)
      data[key] = inner
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
      continue
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }

    if (coerce && typeof value === 'string' && /^\d+$/.test(value)) {
      data[key] = parseInt(value, 10)
      continue
    }

    data[key] = value
  }

  return { data, body }
}
