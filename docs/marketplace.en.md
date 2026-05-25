# Marketplaces

A marketplace is an **index** of plugins — a JSON file (one URL) that
lists `{ name, source }` entries pointing at the actual plugin repos
or paths. Marketplaces don't host plugin code themselves; they're
catalogs.

`x-code` doesn't run its own marketplace. It **subscribes** to other
people's marketplaces. The marketplace.json schema is byte-compatible
with Claude Code's, so subscribing to Anthropic's official marketplace
works out of the box.

See also: [Plugins user guide](plugins.md) ·
[Authoring a plugin](plugin-authoring.md)

---

## What ships by default

The first time `xc` starts up **or you run any `xc plugin …` subcommand**, it writes a single subscription:

| Name                    | Source                                      | Notes                                                                      |
| ----------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| `anthropic-marketplace` | `github:anthropics/claude-plugins-official` | Anthropic's official Claude Code marketplace (200+ plugins), reserved name |

If you remove that subscription with `/plugin marketplace remove
anthropic-marketplace`, a later startup **will not re-add it
automatically** (see [§ Idempotency](#idempotency) below).

---

## Subscribing to a marketplace

```bash
# From a GitHub repo (canonical path .claude-plugin/marketplace.json)
xc plugin marketplace add community github:foo/x-code-marketplace

# From an HTTPS URL that serves marketplace.json directly
xc plugin marketplace add internal https://intranet.example.com/plugins.json

# Then pull its index
xc plugin marketplace refresh community
```

Listing subscriptions:

```bash
xc plugin marketplace list
# →
# Subscribed marketplaces (2):
#   anthropic-marketplace github:anthropics/claude-plugins-official [official]
#   community             github:foo/x-code-marketplace
```

Inspecting a subscribed marketplace's contents:

```bash
xc plugin marketplace info community
xc plugin search linear
```

Removing:

```bash
xc plugin marketplace remove community
```

---

## Reserved names

A small set of marketplace names is reserved to prevent impersonation:

| Name                    | Only acceptable from  |
| ----------------------- | --------------------- |
| `anthropic-marketplace` | `github:anthropics/…` |
| `claude-plugins`        | `github:anthropics/…` |
| `x-code-official`       | `github:woai3c/…`     |

Trying to subscribe to a reserved name with a non-canonical source is
rejected at the API level:

```bash
$ xc plugin marketplace add anthropic-marketplace github:bad/marketplace
Marketplace name "anthropic-marketplace" is reserved; only sources
under github:anthropics/* may use it. Got: github:bad/marketplace
```

This is a name-collision guard, not a security audit — you're free to
subscribe to any non-reserved name from any source.

---

## marketplace.json schema

`xc` uses the public Claude Code marketplace schema — a file you
publish for `xc` works for Claude Code unchanged. The canonical path
inside a repo is **`.claude-plugin/marketplace.json`**.

Reference real-world examples: `anthropics/claude-code` and
`anthropics/claude-plugins-official`.

```jsonc
{
  "$schema": "https://json.schemastore.org/claude-code-marketplace.json",
  "name": "community",
  "version": "1.0.0",
  "description": "Community-curated plugins.",
  "owner": { "name": "Foo Org", "url": "https://foo.example" },
  "plugins": [
    {
      "name": "linear",
      "description": "Linear issue integration",
      "version": "1.2.0",
      "author": { "name": "...", "email": "..." },
      "category": "productivity",
      "source": "./plugins/linear", // string shortcut: subdir of this marketplace's own repo
    },
    {
      "name": "k8s",
      "source": "github:foo/k8s-plugin", // string shortcut: github
    },
    {
      "name": "from-monorepo",
      "source": {
        // git-subdir: a subpath inside some other git repo
        "source": "git-subdir",
        "url": "https://github.com/42Crunch-AI/claude-plugins.git",
        "path": "plugins/api-security",
        "ref": "v1.5.5",
      },
    },
  ],
}
```

> **`name` vs subscription alias**: the `name` inside `marketplace.json`
> (e.g. `claude-plugins-official` for the Anthropic one) is what the
> upstream author calls their catalog. The `<alias>` you pick when
> running `xc plugin marketplace add <alias> <source>` is what x-code
> treats as the canonical identity (cache paths, the `<plugin>@<alias>`
> install id, what `/plugin marketplace list` shows, etc.). When they
> differ, `/plugin marketplace info <alias>` prints an extra
> `Upstream name: <upstream-name>` line so you can see both. That's
> why you can subscribe to Anthropic's catalog as the easier-to-type
> `anthropic-marketplace` instead of typing `claude-plugins-official`
> every time.

### Accepted `source` shapes

`xc` accepts every wire form Claude Code marketplaces use (sampled
from `anthropics/claude-code` and `anthropics/claude-plugins-official`):

| Shape                                                                                                     | Notes                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"./plugins/foo"` / `"../shared/x"`                                                                       | **String relative path** — subdir of the marketplace's own repo. Most common; suits monorepo hosting (Anthropic's own uses this)                          |
| `"github:owner/repo[#ref]"`                                                                               | **String GitHub shortcut**                                                                                                                                |
| `"https://..."` / `"git@..."`                                                                             | **String git URL**                                                                                                                                        |
| `{ source: "git-subdir", url, path, ref?, sha? }`                                                         | **Object git-subdir** — subdir of a different git repo. `sha` is optional; when present, the installer verifies it after clone and hard-fails on mismatch |
| `{ source: "url", url, sha? }`                                                                            | **Object full git URL**                                                                                                                                   |
| `{ source: "github", owner, repo, ref?, subdir? }` or `{ source: "github", repo: "owner/repo", commit? }` | **Object GitHub** — owner/repo can be separate or combined; `commit` is an alias for `ref`                                                                |
| `{ source: "git", url, ref?, subdir? }`                                                                   | **Object git**                                                                                                                                            |
| `{ source: "local", path }`                                                                               | **Local path** — dev only, not portable                                                                                                                   |

Constraints:

- String relative paths (`"./plugins/foo"`) only make sense when the marketplace was fetched via git clone — marketplaces subscribed by a raw HTTPS JSON URL can't reference relative subdirs (no repo to subdir into)
- **Integrity check (`sha`) is enforced**: the git/github/git-subdir/url shapes accept an optional `sha` (≥7-char hex commit hash). After clone the installer runs `git rev-parse HEAD` and compares — **mismatch is a hard install failure**, defending against the upstream ref being force-pushed or the repo being compromised between marketplace review and end-user install. When unset, the check is skipped (back-compat with sha-less marketplaces). Short shas prefix-match the full HEAD, same as `git checkout <short>`
- Internally normalised to `{ kind: 'git'|'github'|'local', ..., subdir?, expectedSha? }`; the wire format only surfaces in marketplace.json

---

## Hosting your own marketplace

Two simple shapes work:

**1. A GitHub repo** with `.claude-plugin/marketplace.json`.

Subscribers run:

```bash
xc plugin marketplace add <name> github:youruser/yourrepo
```

The CLI does a shallow clone, reads `marketplace.json`, caches it,
deletes the clone. Subsequent `xc plugin marketplace refresh <name>`
re-clones.

**2. An HTTPS endpoint** that serves `marketplace.json` directly.

Subscribers run:

```bash
xc plugin marketplace add <name> https://example.com/marketplace.json
```

The CLI fetches via `fetch()`. Useful for internal corporate
marketplaces — you can serve different indexes to different VPNs,
require TLS, etc.

Both forms cache the parsed index under
`~/.x-code/plugins/marketplaces/<name>/marketplace.json` so offline
use works after the first refresh.

---

## Caching

After `xc plugin marketplace refresh <name>`, the index lives at
`~/.x-code/plugins/marketplaces/<name>/marketplace.json`. The cache
file's mtime is used as a "freshness" marker — there's currently no
automatic TTL refresh, so users (or scripts) call `refresh` when they
want a fresh pull.

A future improvement is opt-in background refresh; today it's manual.

---

## Curating your own

Three rough patterns we've seen work:

1. **Pure curation** — your marketplace.json lists plugins from other
   people's repos. Zero hosting overhead; you act as the trust
   intermediary. Useful for internal corp marketplaces ("here are the
   ones our security team vetted").

2. **Author + curate** — you publish plugins under your own GitHub
   org and list them in your marketplace. Standard ecosystem owner
   model.

3. **Mirror** — your marketplace.json points at the same plugin repos
   another marketplace lists. Useful for high-availability or for
   stripping non-mandatory entries from a larger upstream list.

In all three, the marketplace.json itself stays small — just an index.
The plugins themselves live wherever you point at.

---

## Idempotency

`ensureDefaultMarketplaces()` (the function that writes the default
`anthropic-marketplace` subscription on first CLI launch — or on the
first `xc plugin …` subcommand invocation) checks
`known_marketplaces.json` and skips if any entry is present. **Once
the file exists, it's never overwritten** — so removing the default
subscription sticks across restarts.

If you later want it back: `xc plugin marketplace add
anthropic-marketplace github:anthropics/claude-plugins-official`.

---

## Compatibility with Claude Code

Anthropic's official Claude Code marketplace publishes a
`marketplace.json` at the schema we describe above. `xc` reads it
without translation. The same goes for any third-party Claude Code
marketplace — subscribing to it from `xc` works as long as the
listed plugins use one of:

- `.claude-plugin/plugin.json`
- `.x-code-plugin/plugin.json`
- `plugin.json`

at their root. (`xc` probes those three paths in that priority order.)

Plugins that use Claude Code-only manifest fields (`output-styles`,
`lspServers`) install fine; those specific fields are silently dropped.

---

## Troubleshooting

| Symptom                                        | Try                                                                                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `add` rejected with "reserved"                 | The name's in [§ Reserved names](#reserved-names) and your source doesn't match. Use a different name.     |
| `refresh` fails with HTTP error                | The source URL is wrong, or the git repo doesn't have `marketplace.json` at the root.                      |
| `info` says "no cached index"                  | Run `refresh` first.                                                                                       |
| `search` returns nothing for a known plugin    | Run `refresh` — the index may be stale, or the plugin may live in a marketplace you haven't subscribed to. |
| Want to migrate from Claude Code's marketplace | It's already subscribed by default. Just `xc plugin install <name>@anthropic-marketplace`.                 |
