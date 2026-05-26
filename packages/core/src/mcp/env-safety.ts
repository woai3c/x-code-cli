// @x-code-cli/core — Reject env vars that are runtime code-injection vectors
//
// MCP stdio servers inherit an `env` map straight through to spawn(). That
// map can come from three sources:
//   1. the user typing `xc mcp add --env KEY=VAL`
//   2. the project / user mcp.json file
//   3. a plugin manifest declaring its own mcpServers
//
// (3) is the one this module exists to defend. Plugins run with the trust
// the user gave them at install time, but a key like `NODE_OPTIONS=--require
// ./evil.js` would let a plugin turn any node-based MCP server into
// arbitrary code execution the next time it starts — escalating from
// "manifest install" to "RCE under the user's account". The same trick
// works on Linux (LD_PRELOAD) and macOS (DYLD_INSERT_LIBRARIES), and on
// Python/Perl/Ruby runtimes via their respective *STARTUP / *OPT names.
//
// We sit at the spawn boundary (registry.connectOneServer) so every source
// is covered by one check, not just the CLI parser.
//
// This is a denylist, not an allowlist: legitimate MCP servers need to
// accept arbitrary env keys for API tokens / app config, so an allowlist
// would be unworkable. The denylist is short and targeted at names whose
// only legitimate purpose is "load this code on start".

/** Env names that runtimes interpret as "load this code on start".
 *  Compared case-insensitively (see {@link assertSafeEnv}). */
const DANGEROUS_ENV_KEYS = new Set<string>([
  // Node
  'NODE_OPTIONS',
  // Linux dynamic linker
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  // macOS dynamic linker
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_FALLBACK_LIBRARY_PATH',
  'DYLD_FALLBACK_FRAMEWORK_PATH',
  // Shell init / per-command hooks. BASH_ENV runs on non-interactive bash;
  // ENV runs on POSIX sh; PROMPT_COMMAND on every interactive prompt.
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  // Python
  'PYTHONSTARTUP',
  'PYTHONPATH',
  // Perl
  'PERL5OPT',
  'PERL5LIB',
  // Ruby
  'RUBYOPT',
  'RUBYLIB',
])

export class UnsafeEnvError extends Error {
  constructor(public readonly key: string) {
    super(
      `Env key "${key}" is blocked by the MCP env safety check: it is a runtime ` +
        `code-loading hook (NODE_OPTIONS / LD_PRELOAD-class) and would let an MCP ` +
        `config or plugin manifest run arbitrary code at server start. If you ` +
        `really need this, export it in the shell that launches xc instead.`,
    )
    this.name = 'UnsafeEnvError'
  }
}

/** Throw {@link UnsafeEnvError} if `env` contains a denylisted key.
 *
 *  Comparison is case-insensitive: Windows env names are case-insensitive
 *  at the OS level, so rejecting `NODE_OPTIONS` while allowing
 *  `Node_Options` would be theatre. POSIX env names are case-sensitive but
 *  no legitimate config uses non-uppercase variants of these keys. */
export function assertSafeEnv(env: Record<string, string> | undefined): void {
  if (!env) return
  for (const k of Object.keys(env)) {
    if (DANGEROUS_ENV_KEYS.has(k.toUpperCase())) {
      throw new UnsafeEnvError(k)
    }
  }
}
