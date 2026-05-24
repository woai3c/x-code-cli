# Knowledge Base & Auto-memory — Usage Guide

X-Code CLI loads "project background + your preferences + key facts from
last session" into the system prompt automatically at the start of each
session. You don't need to re-explain your project structure, naming
conventions, or last-meeting decisions every time.

中文版：[knowledge.md](./knowledge.md)

---

## 5-layer loading order

At startup, the layers are concatenated in this order. **Later layers
win** on duplicate names or shadowing concepts:

```
1. ~/.x-code/AGENTS.md                  # user-scope preferences (hand-written)
2. ~/.x-code/memory/auto.md             # user-scope auto-memory (AI-written)
3. <repo>/AGENTS.md chain               # walked from cwd up to .git root, root → leaf
4. <repo>/.x-code/memory/auto.md        # project auto-memory (AI-written)
5. <repo-root>/AGENTS.local.md          # project personal prefs (hand-written, gitignored)
```

Step 3's "chain" means: when you're working in a monorepo subpackage,
that subpackage's `AGENTS.md` overrides the root `AGENTS.md` — leaf wins.

> **Windows paths**: `~/.x-code` maps to `%USERPROFILE%\.x-code`.

---

## AGENTS.md vs CLAUDE.md

At each layer, the loader prefers `AGENTS.md` and falls back to
`CLAUDE.md` (Claude Code compat, read-only) when absent.

**Practical effects**:

- A project that already has `CLAUDE.md` works as-is — no rewrite needed
- `/init` only ever writes `AGENTS.md` (both for first-create and update;
  never touches `CLAUDE.md`)
- Migrating from Claude Code: keep `CLAUDE.md` as-is; or move its content
  to `AGENTS.md` and delete `CLAUDE.md` for a clean break

---

## What goes in each file

### `~/.x-code/AGENTS.md` — user-scope preferences

Cross-project facts and conventions. Example:

```markdown
# My preferences

- I use Vitest, not Jest
- TypeScript projects prefer strict mode (`strict: true`); no `any`
- Git commits follow Conventional Commits (`feat:` / `fix:` / `chore:` …)
- Code comments in English; user-facing docs in Chinese

# My usual project shape

- monorepo via pnpm workspace
- packages live under `packages/<name>/src/...`
```

### `<repo>/AGENTS.md` — project shared (committed)

Project architecture / conventions, shared with the team. Example:

```markdown
# x-foo project

## Architecture

- `packages/api/` Hono server, deploys to Cloudflare Workers
- `packages/web/` Next.js 14 app router, deploys to Vercel
- `packages/shared/` cross-end shared types + utils

## Don't touch

- `migrations/` is owned by the DBA team; PRs should not modify it
- `prisma/seed.ts` runs in staging only; production uses a dedicated script

## Common commands

- `pnpm dev` brings the whole monorepo up (db + api + web)
- `pnpm bench:api` runs the API bench suite
```

In a monorepo, drop a subpackage's own `AGENTS.md` to override root-level
conventions (leaf wins).

### `<repo-root>/AGENTS.local.md` — project personal (gitignored)

Your local preferences — never committed. Example:

```markdown
# My local prefs

- macOS, fish shell
- Only run tests under packages/api/ locally — CI does the full sweep
- `pnpm bench:api -- --reporter=tap` for tap output
```

---

## Auto-memory (`auto.md`)

After each turn, the CLI scans the recent transcript and writes durable
facts to `auto.md`. These load as context next session.

What gets captured:

- **user**: stable facts about the user's role / skills / goals
- **feedback**: user corrections or confirmations ("don't mock the db",
  "yes that style was right")
- **project**: ongoing work / decisions / non-obvious project state
- **reference**: pointers to external resources (Linear project, Grafana
  dashboard, etc.)

Two files:

| Path                            | Scope   |
| ------------------------------- | ------- |
| `~/.x-code/memory/auto.md`      | User    |
| `<repo>/.x-code/memory/auto.md` | Project |

Each memory is a standalone Markdown section with YAML frontmatter (type,
key, date, etc. as metadata).

### Inspect

```text
> /memory
(the agent renders the list, grouped by category, project + user combined)
```

### Edit by hand

Just edit the file — memories are Markdown, what you see is what's stored.
`/memory` reads the same file you're editing.

To make the agent **forget** something, delete the corresponding section.
To **add** a fact, hand-write a section (minimum form: `# title` + a body
paragraph).

---

## `/init` — bootstrap an AGENTS.md for a project

Want an `AGENTS.md` for a project that doesn't have one?

```text
> /init
(the agent scans the repo + git log + README, writes an initial AGENTS.md to the project root)
```

If `AGENTS.md` already exists, `/init` **updates** it incrementally
rather than overwriting.

Safe to run repeatedly — the agent diffs current state vs the existing
file and folds in what's missing.

---

## Practical tips

- **Write decisions, not facts** — the agent can grep "which ORM is
  used", but it can't guess "why we didn't pick X". Lean toward "why"
  over "what"
- **Keep AGENTS.md short** — it lands in every session's system prompt;
  long = token cost. A 500-line AGENTS.md is worse than a 50-line one
  with a `## Detailed architecture` line linking to `docs/architecture.md`
- **`.local.md` is for you only** — don't put team conventions there or
  your colleagues can't reproduce your environment
- **Don't hand-edit `auto.md` for config** — it's AI-written to be AI-read;
  hand edits work but get overwritten as new memories land. For stable
  preferences, use `AGENTS.md`

---

## Troubleshooting

| Symptom                           | Fix                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------- |
| Agent doesn't know my preferences | Restart `xc` — AGENTS.md is read at startup only                                                    |
| `/memory` is empty                | Normal for fresh projects; populates after a few sessions                                           |
| Auto-memory doesn't seem to land  | Check `~/.x-code/memory/auto.md` exists; `DEBUG_STDOUT=1` then grep `memory.`                       |
| Migrating from Claude Code        | Leave `CLAUDE.md` in place — the loader reads it as a fallback when `AGENTS.md` is missing          |
| AGENTS.md slows startup           | Split it — keep conventions in the main file, move detailed docs elsewhere with a "see docs/X" link |
