# Plugins — User Guide

A **plugin** is an installable package that contributes one or more of:
skills, sub-agents, slash commands, MCP servers, or lifecycle hooks.
Plugins are how third-party authors extend `xc` without forking the CLI.

See also: [Authoring a plugin](plugin-authoring.md) ·
[Hooks reference](hooks.md) · [Marketplace reference](marketplace.md)

---

## TL;DR

```bash
# Install from a subscribed marketplace
xc plugin install linear@anthropic-marketplace

# Install from a GitHub repo
xc plugin install github:owner/repo

# Install from a local path (great for plugin development)
xc plugin install ./my-plugin

# List what's installed
xc plugin list

# Remove a plugin
xc plugin uninstall linear@anthropic-marketplace
```

After install or uninstall, **restart `xc`** for the contributions
(skills / agents / MCP / hooks) to take effect.

---

## Two ways to drive it

The same operations exist in both surfaces — pick whichever you're in:

| Action              | Slash command (interactive)    | Non-interactive                      |
| ------------------- | ------------------------------ | ------------------------------------ |
| List plugins        | `/plugin list`                 | `xc plugin list`                     |
| Show plugin details | `/plugin info <id>`            | `xc plugin info <id>`                |
| Install             | `/plugin install <source>`     | `xc plugin install [--yes] <source>` |
| Uninstall           | `/plugin uninstall <id>`       | `xc plugin uninstall <id>`           |
| Enable / disable    | `/plugin enable\|disable <id>` | `xc plugin enable\|disable <id>`     |
| Search marketplaces | `/plugin search <keyword>`     | `xc plugin search <keyword>`         |
| Update              | `/plugin update <id>`          | `xc plugin update <id>`              |
| Diagnose problems   | `/plugin doctor`               | `xc plugin doctor`                   |
| Manage marketplaces | `/plugin marketplace …`        | `xc plugin marketplace …`            |

The non-interactive form is intended for scripts and CI. `xc plugin
install` runs a y/N consent prompt by default; pass `--yes` to skip it
when you're scripting trusted installs.

---

## Install sources

`xc plugin install` accepts four kinds of source:

| Form                          | Example                                   | Notes                                                                                                                                                |
| ----------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>@<marketplace>`        | `linear@anthropic-marketplace`            | Looks up the entry in the cached marketplace index and installs from its declared source. Requires the marketplace to be subscribed (and refreshed). |
| `github:<owner>/<repo>[#ref]` | `github:foo/bar`, `github:foo/bar#v1.2.0` | Shallow `git clone` of the repo. Ref is optional and may be a branch or tag.                                                                         |
| `https://…` or `git@…`        | `https://gitlab.example/foo/bar.git`      | Any git-clone-able URL.                                                                                                                              |
| Filesystem path               | `./my-plugin`, `/abs/path/to/plugin`      | Useful for plugin authors iterating locally.                                                                                                         |

The first three install under the `local` marketplace unless you used
the `<name>@<marketplace>` form. The marketplace name shows up in
`/plugin list` so you can tell at a glance where each plugin came from.

---

## Install-time consent

`xc plugin install` shows a preview before committing the install:

```
About to install: linear@anthropic-marketplace v1.2.0
  Linear issue integration

  Source:      github:anthropics/linear-plugin
  Marketplace: anthropic-marketplace [reserved/official] [verified]
  Author:      Anthropic
  License:     MIT

  Will contribute:
    - skills (added to /skill list)
    - MCP servers (will be spawned as subprocesses): linear
    - Lifecycle hooks (will run shell commands on: PostToolUse)

Proceed with install? [y/N]
```

The two **red** items in the list — MCP servers and lifecycle hooks —
are the load-bearing trust decisions: both run code on your machine.
Inspect the source before answering `y` for anything from a marketplace
you don't trust.

In non-TTY environments (CI, piped install scripts), the prompt
defaults to **no**. Pass `--yes` to opt out:

```bash
xc plugin install --yes linear@anthropic-marketplace
```

The slash-command flow (`/plugin install`) does not currently show this
prompt — typing the command in the chat is treated as explicit intent.
We may add an inline confirmation modal later; track this as a known
limitation today.

---

## Scopes

A plugin's enable flag lives in one of two scopes — same convention as
skills (see `packages/core/src/skills/settings.ts`):

| Scope     | File                                | Notes                                    |
| --------- | ----------------------------------- | ---------------------------------------- |
| `user`    | `~/.x-code/settings.json`           | Default for `xc plugin enable\|disable`. |
| `project` | `<cwd>/.x-code/settings.local.json` | Per-user, gitignored. Overrides `user`.  |

The shape inside each file:

```jsonc
{
  "enabledPlugins": {
    "linear@anthropic-marketplace": true,
    "k8s-debug@local": false,
  },
}
```

A plugin not listed in either scope defaults to **enabled**. Disable
explicitly when you want it off. `project` settings win over `user`.

Pick the scope explicitly via `--scope`:

```bash
# Disable a plugin in this project only, leaving other projects untouched
xc plugin disable linear@anthropic-marketplace --scope=project
# Enable in user scope (the default)
xc plugin enable linear@anthropic-marketplace --scope=user
```

The slash command form (`/plugin enable | disable`) accepts the same flag.

---

## Filesystem layout

Everything plugin-related lives under `~/.x-code/plugins/`:

```
~/.x-code/plugins/
├── known_marketplaces.json          # subscribed marketplaces
├── marketplaces/
│   └── anthropic-marketplace/
│       └── marketplace.json         # cached marketplace index
├── cache/
│   └── anthropic-marketplace/
│       └── linear/
│           └── 1.2.0/               # actual installed plugin
│               ├── .claude-plugin/plugin.json
│               ├── skills/
│               ├── mcp.json
│               └── hooks/hooks.json
├── data/
│   └── linear@anthropic-marketplace/  # persistent per-plugin data
│                                       # (survives uninstall+reinstall)
└── installed_plugins.json             # bookkeeping
```

The `data/` directory is preserved on uninstall, so reinstalling
recovers any state a plugin chose to save there.

---

## Disabling the plugin system entirely

Two startup escape hatches:

```bash
xc --no-plugins    # skip plugin discovery entirely
xc --no-hooks      # load plugins but skip hook execution
```

Use `--no-plugins` when you suspect a plugin is the cause of a
problem; `--no-hooks` keeps skills / agents / MCP from broken plugins
active but mutes lifecycle hooks for a session.

---

## When changes take effect — `/plugin refresh`

Plugin contributions (skills / sub-agents / commands / hooks) are folded
into their respective registries at CLI startup. After installing,
uninstalling, enabling, or disabling a plugin mid-session, run
**`/plugin refresh`** to reload everything live without restarting:

```text
> /plugin refresh
Reloaded plugins — added: my-new-plugin@local; unchanged: linear@anthropic-marketplace.
Downstream: 3 skill change(s), 1 command change(s).
Note: plugin-contributed MCP servers are not restarted — run `/mcp refresh` if needed.
Note: next message rebuilds the system prompt, so prompt-cache will miss once.
```

What happens internally:

1. Re-scan installed plugins, re-parse every manifest.
2. Rebuild PluginRegistry in place (object identity stays — every captured ref is still valid).
3. Fold new skills / sub-agents / commands / hooks into their registries.
4. Invalidate `systemPromptCache` so the next message rebuilds the prompt (one cache miss, expected).

**MCP exception**: plugin-contributed MCP servers spawned a child process
at first launch — hot reload does not restart them. After installing or
removing a plugin with MCP, follow up with `/mcp refresh`.

`/plugin list` and `/plugin info` always reflect the live state.

---

## `userConfig`: prompt at install time

A plugin's manifest can declare what user-supplied configuration it
needs (API keys, account ids, base URLs, …):

```jsonc
{
  "userConfig": [
    {
      "key": "LINEAR_API_KEY",
      "type": "string",
      "sensitive": true,
      "prompt": "Enter your Linear API key",
      "required": true,
    },
    { "key": "BASE_URL", "type": "string", "default": "https://api.example.com" },
  ],
}
```

At install time (when **not** running with `--yes`) the CLI walks each
field and prompts for a value; `sensitive: true` fields are entered
with local echo suppressed (git-style password input).

Values are stored in `~/.x-code/plugins/user-config.json` with file mode
`0600` (owner-read-write only). At hook execution and at plugin-
contributed MCP server launch, they are injected into the child process
`env` keyed by the manifest's `key`. So a hook script can just read
`process.env.LINEAR_API_KEY` — no glue.

⚠️ v1 caveat: `sensitive: true` currently only controls **display
during input**, not the at-rest storage. Real OS keychain integration
(macOS Keychain / Windows Credential Manager / Linux libsecret) is a
followup. On Windows `0600` is effectively a no-op for ACL reasons —
plan storage accordingly.

`--yes` installs skip the prompt; values stay unset. To pre-seed values
for CI, hand-write `~/.x-code/plugins/user-config.json` before the
install.

---

## `--plugin-debug` for diagnostics

To watch plugin loading, hook execution, and marketplace fetches live:

```bash
xc --plugin-debug
# equivalent to
XC_PLUGIN_DEBUG=1 xc
```

This mirrors `plugins.*` / `plugin.*` / `hooks.*` / `marketplace.*`
debug breadcrumbs to stderr, without flipping `DEBUG_STDOUT=1` (which
would dump every debug tag, far noisier).

---

## Troubleshooting

| Symptom                                 | First thing to try                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Plugin doesn't appear after install     | Restart `xc`. Contributions are bound at startup.                                                        |
| `/plugin doctor` shows load errors      | Check the file path it reports — usually a manifest typo.                                                |
| MCP server from a plugin won't connect  | Run `/mcp list` — plugin-contributed servers appear there too.                                           |
| Hook fires unexpectedly                 | Set `DEBUG_STDOUT=1`, restart, then `tail ~/.x-code/logs/debug.log` and grep `hooks.`.                   |
| Suspect a plugin is breaking everything | Launch with `xc --no-plugins`. If the problem disappears, isolate with `/plugin disable <id>` + restart. |
| Hook is slow / hangs                    | Launch with `xc --no-hooks`. Each hook also has a 5s default timeout.                                    |

---

## Compatibility with Claude Code / Codex plugins

`xc` deliberately reads `.claude-plugin/plugin.json` in addition to its
native `.x-code-plugin/plugin.json` path. A plugin authored for Claude
Code will install in `xc` without modification — its skills, agents,
MCP servers, and hooks all wire up the same way. The two fields we
don't support (`output-styles`, `lspServers`) are silently ignored;
everything else loads.

Gemini extensions (`gemini-extension.json`) are **not** supported.
Trying to install one prints a friendly error pointing at this doc.
