# Authoring a Plugin

A plugin is a directory with a manifest at the root. This page is the
schema reference plus the layout conventions x-code expects.

See also: [Plugins user guide](plugins.en.md) · [Hooks](hooks.en.md) ·
[Marketplace](marketplace.en.md)

---

## Minimum viable plugin

The smallest plugin that loads:

```
my-plugin/
└── .x-code-plugin/
    └── plugin.json
```

```json
{
  "name": "my-plugin",
  "version": "0.1.0"
}
```

Install it (from inside `my-plugin`'s parent dir):

```bash
xc plugin install ./my-plugin
```

You'll get a "no contributions" warning in `/plugin info` — that's fine.
Add contributions below to make it useful.

---

## Manifest paths the loader probes

In order:

1. `.x-code-plugin/plugin.json` ← preferred for new plugins
2. `.claude-plugin/plugin.json` ← for Claude Code compatibility
3. `plugin.json` ← tolerated

If only `gemini-extension.json` is present, install is rejected with a
pointer to this page. (See [plugins.en.md § Compatibility](plugins.en.md).)

---

## Manifest reference

Only `name` is required. If `version` is omitted, X-Code uses `0.0.0` for
installation records and cache paths. Unknown top-level fields are silently
dropped, so unsupported contributions such as `output-styles` or `lspServers`
do not activate.

> Manifests and referenced JSON files are parsed as strict JSON; comments and
> trailing commas are not accepted. The `jsonc` block below is an annotated
> field reference and must be cleaned before copying it into `plugin.json`.

```jsonc
{
  // Schema version. Always "1" today; future breaking changes will
  // bump this. If absent, "1" is assumed.
  "schemaVersion": "1",

  // ── Identity ────────────────────────────────────────────────────
  "name": "linear", // [a-z0-9][a-z0-9-]* — used as
  // a filesystem-safe path component
  // on every OS
  "version": "1.2.0", // optional; defaults to "0.0.0"; semver is not enforced

  "description": "Linear issue integration",
  "author": {
    // OR just a string "Name"
    "name": "Anthropic",
    "email": "support@anthropic.com",
    "url": "https://anthropic.com",
  },
  "keywords": ["productivity", "issue-tracker"],
  "homepage": "https://github.com/anthropics/linear-plugin",
  "license": "MIT",

  // ── Contributions (paths are relative to plugin root) ──────────
  //
  // Each `<thing>` field below points at a directory or, where noted,
  // either a file path or an inline object. All are optional.

  "skills": "./skills", // directory of <name>/SKILL.md
  "agents": "./agents", // directory of <name>.md
  "commands": "./commands", // each .md becomes a /<name> slash command;
  // body is a prompt template that
  // supports $ARGUMENTS and ${CLAUDE_PLUGIN_ROOT}

  // mcpServers: either a path to a JSON file shaped
  // `{ "mcpServers": { ... } }` (same as ~/.x-code/config.json),
  // OR the raw record inline. Inline form shown:
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@example/linear-mcp"],
    },
  },

  // hooks: either a path to a hooks.json, OR an inline object. See
  // docs/hooks.en.md for the full event list and decision protocol.
  // 10 events: SessionStart / UserPromptSubmit / PreToolUse / PostToolUse
  // / PreCompact / PostCompact / SubagentStart / SubagentStop /
  // TurnComplete / SessionEnd
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "writeFile|edit",
        "command": "node ${pluginDir}/hooks/lint.js",
        // Cross-platform overrides — set whichever OSes need different syntax
        "commandWindows": "node \"${pluginDir}/hooks/lint.js\"",
        "timeout": 5000,
      },
    ],
  },

  // ── User-supplied config items (prompted at install + injected into hook/MCP env) ──
  "userConfig": [
    {
      "key": "LINEAR_API_KEY",
      "type": "string",
      "sensitive": true, // input echo suppressed (git-style password). v1
      // stores values in a 0600 file; OS keychain (keytar) is a followup PR.
      "prompt": "Enter your Linear API key",
      "required": true,
    },
  ],
  // At install time (`xc plugin install <src>` without `--yes`) the CLI
  // walks each field and prompts for a value, writing the result to
  // ~/.x-code/plugins/user-config.json (mode 0600). At runtime each value
  // is injected into hook subprocess env AND plugin-contributed MCP server
  // env, keyed by `key`. NOTE: the slash form `/plugin install` always
  // runs implicit-yes and SKIPS this prompt — userConfig-bearing plugins
  // must be installed via `xc plugin install`; see plugins.en.md's slash
  // command limitations section.

  // ── Dependencies & engines ─────────────────────────────────────
  "dependencies": ["base-skills@anthropic-marketplace"],
  "engines": { "x-code": ">=0.5.0" },
}
```

### Field-level notes

- **`name`** — lowercase letters, digits, dashes. Must start with a
  letter or digit.
- **`skills`** / **`agents`** / **`commands`** — paths to the
  respective directories. **Most Claude Code plugins omit these
  fields**; the loader auto-detects `skills/` / `agents/` / `commands/`
  subdirs by convention. Only set explicitly when using a non-standard
  layout. Each `.md` inside `commands/` becomes a `/<name>` slash
  command — its body is a prompt template and supports both
  `$ARGUMENTS` and `${CLAUDE_PLUGIN_ROOT}` substitution. The same
  `/<name>` slash command can also be defined directly in
  `~/.x-code/commands/<name>.md` (user scope) or
  `<cwd>/.x-code/commands/<name>.md` (project scope) — precedence is
  **project > plugin > user** (see the "Custom slash commands"
  feature bullet in the README).
- **`mcpServers`** — path or inline object. When unset, the loader
  auto-detects `.mcp.json` (Claude Code convention) or `mcp.json`.
  Per-server schema follows `~/.x-code/config.json`; environment references
  use `${NAME}` or `${NAME:-fallback}`. Saved `userConfig` values are injected
  directly into stdio server environments, so they should not be repeated as
  `${NAME}` entries. X-Code does not inject a plugin-root variable into MCP
  args; use an installed executable/package or a user-configured path for a
  bundled server.
- **`hooks`** — path or inline object. When unset, the loader
  auto-detects `hooks/hooks.json`. See [hooks.en.md](hooks.en.md) for
  the event list and decision JSON.

---

## Layout convention

```
my-plugin/
├── .x-code-plugin/
│   └── plugin.json
├── skills/
│   └── search/
│       ├── SKILL.md            # YAML frontmatter + body
│       └── references/         # bundled files indexed when the registry loads
│           └── api.md
├── agents/
│   └── triage.md               # sub-agent definition
├── commands/                   # each .md = one /<name> slash command
│   └── linear.md
├── mcp.json                    # if you split mcpServers into a file
├── hooks/
│   ├── hooks.json              # if you split hooks into a file
│   ├── lint.js
│   └── audit.sh
├── README.md
└── LICENSE
```

You don't have to use this exact layout — the `skills` / `agents` /
`commands` / `mcpServers` / `hooks` manifest fields can each point
anywhere relative to the plugin root. Sticking close to the convention
makes plugins easier to read.

---

## Iterating locally

1. Write the manifest and any contributions.
2. `xc plugin install ./my-plugin` — copies into
   `~/.x-code/plugins/cache/local/<name>/<version>/` and records the
   install.
3. In an open session, run `/plugin refresh` to pick up contributions; starting
   a new `xc` session also loads them.
4. Iterate. Re-running `xc plugin install ./my-plugin` over the same
   plugin overwrites the cache (same-version reinstall is supported);
   bump the manifest version to install as a separate version.

For tighter loops, you can edit files directly inside the cache dir —
it survives restarts. Don't ship that as your dev workflow though:
re-running the install ensures your source dir is the source of truth.

---

## Testing your plugin

The repo's existing fixtures show the shape of a test plugin —
see `packages/core/tests/plugins-install-load.test.ts` for examples
that install a plugin from a temp dir and assert the loader picks up
its contributions.

The integration boundary (plugin → existing loaders) is in
`packages/core/src/plugins/integration.ts`. If a plugin's MCP / hook
config has a parse error, it surfaces via `/plugin doctor` rather than
crashing the CLI — your tests should cover that path too.

---

## Common pitfalls

| Pitfall                                     | Fix                                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` rejected with regex error            | Use lowercase letters, digits, dashes only. No underscores, no uppercase.                                                                                                                                                                                               |
| Hook never fires                            | Run `/plugin refresh` after install (in-session hot reload, no restart needed) — or restart `xc`. Verify via `xc --plugin-debug` and look for `hooks.exec-ran` entries in `~/.x-code/logs/debug.log`.                                                                   |
| Plugin path variable not expanded           | Hooks use `${pluginDir}` / `${pluginDataDir}`; slash command templates use `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}`. MCP args and env only expand `${VAR}` / `${VAR:-fallback}` from process env and have no plugin-root variable.                             |
| `${pluginDataDir}` write fails              | Auto-created at `~/.x-code/plugins/data/<sanitised-plugin-id>/`, preserved across versions. First substitution does `mkdir -p`; permission errors surface in the shell. **Don't** write persistent data to `${pluginDir}` — it gets wiped on every reinstall / upgrade. |
| Plugin loads but contributions don't appear | Run `/plugin info <id>` to confirm the manifest was parsed and the contribution paths exist on disk.                                                                                                                                                                    |
| Want to release publicly                    | Publish to a marketplace.json that lists your plugin's git URL; tell users to `xc plugin marketplace add <name> <source>`. See [marketplace.en.md](marketplace.en.md).                                                                                                  |
