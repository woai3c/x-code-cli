// @x-code-cli/core — Environment variable expansion for MCP configs
//
// Supports two forms inside any string field of an MCP server config:
//   ${VAR}             — expand or throw if VAR is unset
//   ${VAR:-fallback}   — expand or use the literal fallback
//
// We intentionally do NOT support arbitrary shell expansion (no `$VAR`
// without braces, no command substitution, no nested `${${A}}`). Anything
// fancier should be done in user-land before X-Code launches.

/** Thrown when a ${VAR} reference can't be resolved. The loader catches
 *  this and marks the server `failed` so the rest of the CLI keeps going. */
export class EnvExpansionError extends Error {
  constructor(public varName: string) {
    super(`Required environment variable not set: ${varName}`)
    this.name = 'EnvExpansionError'
  }
}

const REF_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** Expand all ${VAR} references in a single string. */
export function expandEnvString(input: string, env: NodeJS.ProcessEnv = process.env): string {
  return input.replace(REF_RE, (match, name: string, fallback?: string) => {
    const v = env[name]
    if (v !== undefined && v !== '') return v
    if (fallback !== undefined) return fallback
    throw new EnvExpansionError(name)
  })
}

/** Recursively walk a config value and expand strings. Arrays / plain
 *  objects are traversed; numbers/booleans/null pass through unchanged.
 *  Returns a deep copy — never mutates the input (important: the input
 *  may come straight from a cached parsed config object). */
export function expandEnvDeep<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return expandEnvString(value, env) as unknown as T
  }
  if (Array.isArray(value)) {
    return value.map((v) => expandEnvDeep(v, env)) as unknown as T
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvDeep(v, env)
    }
    return out as unknown as T
  }
  return value
}
