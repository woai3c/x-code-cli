# MCP (Model Context Protocol) — Usage Guide

X-Code CLI ships with a built-in MCP client. Any MCP-protocol server you
configure becomes part of the agent's tool set — the agent calls its tools
the same way it calls the built-ins.

Both **stdio** (local subprocess) and **streamable HTTP** (remote, OAuth-
capable) transports are supported.

中文版：[mcp.md](./mcp.md)

---

## TL;DR

Add an `mcpServers` field to `~/.x-code/config.json` (create the file if
needed), then restart `xc`:

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed-dir"],
    },
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
    },
  },
}
```

After startup, use `/mcp list` to see connection status and `/mcp tools`
to see the tools each server exposes.

---

## Config file locations

| Scope   | Path                         | When to use                                           |
| ------- | ---------------------------- | ----------------------------------------------------- |
| User    | `~/.x-code/config.json`      | Personal-use servers (filesystem, github, etc.)       |
| Project | `<repo>/.x-code/config.json` | Repo-specific servers (internal company server, etc.) |

The two scopes merge: project entries override user-scope entries with the
same name. **Project-level configs trigger a trust dialog the first time
they appear** (matching Claude Code's security model). Declining skips
project servers for that session. The trust decision persists at
`~/.x-code/trusted-projects.json`.

> **Windows paths**: `~/.x-code` maps to `%USERPROFILE%\.x-code` on
> Windows. Not repeated below.

---

## mcpServers schema

### stdio (local subprocess)

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "command": "npx", // required
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "${env:WORK_DIR}"],
      "env": {
        // optional: extra env vars
        "DEBUG": "1",
      },
      "cwd": "/some/dir", // optional: child cwd
      "timeout": 30000, // optional: first-connect timeout in ms (default 30000)
      "enabled": true, // optional: false skips the server
    },
  },
}
```

### HTTP (remote, optional OAuth)

```jsonc
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/", // required
      "headers": {
        // optional: static request headers
        "X-Client": "x-code",
      },
      "timeout": 30000,
      "enabled": true,
    },
  },
}
```

**OAuth**: HTTP servers that require OAuth surface as `needs_auth` on
first connect. Run `/mcp auth <name>` to drive the full OAuth flow — a
browser opens the authorization URL, the callback writes the token to
`~/.x-code/mcp/tokens/<server>.json`. Subsequent launches inject
`Authorization: Bearer ...` automatically.

**Don't hard-code tokens into `headers`** — the OAuth flow handles them.

### Variable expansion

`${VAR}` and `${env:VAR}` inside any string field are expanded against
`process.env` at startup. Missing variables raise an error and mark the
server `failed` (the other servers still load).

```jsonc
{
  "github": {
    "url": "${env:GITHUB_MCP_URL}",
    "headers": { "Authorization": "Bearer ${env:GITHUB_TOKEN}" },
  },
}
```

> **Tip**: any field carrying a secret should use `${env:...}`. Keep the
> secret in your shell rc file rather than committing it to a
> source-controlled config.json.

---

## `/mcp` commands

| Command                | Description                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `/mcp list`            | List every configured server with its status (connected / disabled / needs_auth / failed) |
| `/mcp tools [server]`  | List tools available; optional filter by server name                                      |
| `/mcp add`             | Interactive add of a stdio / HTTP server to user or project config                        |
| `/mcp add-json`        | Add a server from raw JSON (handy for pasting docs examples)                              |
| `/mcp remove`          | Remove a server from config                                                               |
| `/mcp auth <server>`   | Drive the OAuth flow for an HTTP server                                                   |
| `/mcp logout <server>` | Clear the stored OAuth token for a server                                                 |
| `/mcp refresh`         | Re-read config files and reconnect every server (no CLI restart needed)                   |

Example `/mcp list` output:

```
MCP servers:
  filesystem    connected — 11 tools, 0 resources
  github        needs auth — run /mcp auth github to log in
  internal      failed — connect ECONNREFUSED 127.0.0.1:8080
```

---

## Tool naming

MCP tool names take the form `<server>__<tool>` (double underscore). For
example:

- `filesystem__read_file`
- `github__create_issue`

When two servers expose the same tool name, the second gets a hash
suffix (e.g. `read_file_a3f2`) to avoid collision; the loader logs which
server got renamed.

---

## Worked examples

### Example 1: official filesystem server

```jsonc
{
  "mcpServers": {
    "fs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "D:/work"],
    },
  },
}
```

After startup the agent gains `fs__read_file`, `fs__write_file`,
`fs__list_directory`, and so on — all scoped to `D:/work`.

### Example 2: a custom stdio server

```jsonc
{
  "mcpServers": {
    "company": {
      "command": "node",
      "args": ["D:/tools/company-mcp/index.js"],
      "env": {
        "API_KEY": "${env:COMPANY_API_KEY}",
        "ENDPOINT": "https://internal.corp/api",
      },
      "cwd": "D:/tools/company-mcp",
    },
  },
}
```

### Example 3: HTTP server + OAuth

```jsonc
{
  "mcpServers": {
    "linear": {
      "url": "https://mcp.linear.app/sse",
    },
  },
}
```

First run:

```
$ xc
[mcp] linear: needs auth
> /mcp auth linear
Opening browser to authorize linear...
Listening on http://localhost:33421/oauth/callback
[browser opens, user authorizes]
[token saved to ~/.x-code/mcp/tokens/linear.json]
linear connected — 8 tools, 2 resources
```

Subsequent launches inject the Bearer token automatically — no re-auth
needed until the token expires.

---

## Plugin-contributed mcpServers

Plugins can declare `mcpServers` in their manifest (inline or as a file
path). They load identically to user-configured servers, with two
differences:

- **Treated as already-trusted** — the project trust dialog doesn't
  fire (the user already consented to the plugin at install time)
- **Merge order**: user → plugin → project. Project entries still win
  on name collisions
- **Listed in `/mcp list`** alongside user servers

See [plugins.md](./plugins.md) § Contributions for the full picture.

---

## Troubleshooting

| Symptom                                   | Try                                                                                                                                             |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `/mcp list` shows `failed`                | Read the `stderrTail` field (end of `/mcp list` output); usually "command not found" or wrong cwd                                               |
| `needs_auth` and `/mcp auth` does nothing | Confirm the HTTP server actually supports OAuth; some custom servers use static tokens — set `headers: {"Authorization": "Bearer ..."}` instead |
| Tool-name collisions                      | A hash suffix is appended automatically; or rename the server (the `mcpServers` key)                                                            |
| Restarting `xc` feels slow                | `/mcp refresh` reconnects in place — no CLI restart                                                                                             |
| Project config not loading                | Did you decline the trust dialog at startup? Remove the matching path from `~/.x-code/trusted-projects.json` and restart to re-decide           |
| Want to temporarily skip a server         | Set `enabled: false` on the entry — more visible than commenting out the whole block                                                            |

With `DEBUG_STDOUT=1` set, MCP events land in `~/.x-code/logs/debug.log`.
Grep for `mcp.` to follow connects / calls / errors.

---

## Compatibility with Claude Code MCP config

X-Code CLI's `mcpServers` schema matches Claude Code's exactly — copy
the `mcpServers` block from your `~/.claude/config.json` straight into
`~/.x-code/config.json`. One config, two CLIs.
