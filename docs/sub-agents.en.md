# Sub-agents (the `task` tool) — Usage Guide

X-Code CLI supports sub-agent delegation through the `task` tool: the model
can hand an independent sub-task (research, code review, planning) to a
sub-agent with its own system prompt, isolated context window, and
optionally a different model. The sub-agent runs to completion and only
its final answer is folded back into the main agent — intermediate work
doesn't pollute the main conversation.

中文版：[sub-agents.md](./sub-agents.md)

---

## Built-in sub-agents

Four ship in the box:

| Name              | Best for                                                                  | Tool whitelist                                              |
| ----------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `explore`         | Searching a large codebase for a symbol / keyword / call chain; read-only | `readFile`, `glob`, `grep`, `listDir`, `shell` (restricted) |
| `general-purpose` | Catch-all research / multi-step tasks that don't fit elsewhere            | default full tool set (minus `task`)                        |
| `plan`            | Given a task, explore the code and produce an implementation plan         | `readFile`, `glob`, `grep`, `listDir` (read-only)           |
| `code-reviewer`   | Reviewing diffs / PRs                                                     | `readFile`, `glob`, `grep`, `listDir`, `shell` (restricted) |

> Tool names are **camelCase** — they match the keys in `toolRegistry`
> (`packages/core/src/tools/index.ts`). The snake_case spellings
> (`read_file`, `write_file`, etc.) **don't match anything** and silently
> leave the sub-agent with an empty tool set.
>
> `shell (restricted)` means the `shell` tool is available but
> `shellRestrictions` blocks destructive commands by default (`rm`, `mv`,
> `git push`, output redirects, etc. — full list in
> `packages/core/src/agent/sub-agents/built-in.ts:SHELL_DENY_KEYWORDS`).
>
> The `plan` built-in sub-agent does **not** include `enterPlanMode` —
> its output is a Markdown plan, not a session-mode switch. The `/plan`
> CLI flag and the `plan` sub-agent are different things.

The main agent invokes them via the `task` tool:

```text
(the agent calls something like:)
task(subagent_type="explore", description="find all callers of formatDate",
     prompt="Search the repo for callers of formatDate(). Return paths + line numbers.")
```

The sub-agent runs in isolated context (capped by `maxTurns`) and returns
only its final assistant text. Token usage is accumulated into the main
session.

---

## Writing custom sub-agents

Drop a `.md` file under either path:

| Scope   | Path                              |
| ------- | --------------------------------- |
| User    | `~/.x-code/agents/<name>.md`      |
| Project | `<repo>/.x-code/agents/<name>.md` |

Loaded at startup; `/plugin refresh` also re-scans them mid-session
(custom sub-agents share the reload path with plugin-contributed ones).
Project-level wins over user-scope of the same name; both override
built-ins.

> **Windows paths**: `~/.x-code` maps to `%USERPROFILE%\.x-code`.

### File format

```markdown
---
name: my-agent # required; the model invokes this name in task()
description: One sentence on when to use this agent. The model reads this to decide. # required
tools: [readFile, grep, glob] # optional: whitelist of allowed tools (camelCase)
disallowedTools: [shell] # optional: deny on top of the whitelist
model: anthropic:claude-haiku-4-5 # optional: override the parent model (use a cheaper one)
maxTurns: 15 # optional: hard turn cap (default 30)
shellRestrictions: [rm, mv] # optional: keyword blacklist for shell commands (only meaningful when shell is in tools)
---

Your system prompt goes here. Can be multi-paragraph — this is the
entire "instruction set" the sub-agent receives.

If you want the sub-agent to know what tools it has, list them at the
end — but it's not required; the whitelist is enforced regardless.
```

No frontmatter field is checked at runtime besides `name` and
`description`. Everything else has sensible defaults.

### Example: bench-runner

`~/.x-code/agents/bench-runner.md`:

```markdown
---
name: bench-runner
description: Run the benchmark suite once in isolation and report numbers + any regression
tools: [shell, readFile]
model: anthropic:claude-haiku-4-5
maxTurns: 8
shellRestrictions: [rm, sudo, npm publish]
---

Your task is to run the project's bench suite and report results.

1. Execute `pnpm bench` and collect the output
2. Read ./bench-baseline.json for baseline numbers
3. Compare: any operation slower than baseline by >10% counts as a regression
4. Format your output as plain text (no markdown):

   Bench results (vs baseline):
   - sort 1k: 12.3ms (baseline 12.0ms, +2.5%, OK)
   - sort 10k: 178.0ms (baseline 134.0ms, +32.8%, ⚠ regression)

   Verdict: 1 regression

Don't try to fix any regression — just report.
```

When you ask the main agent "run bench and see if anything regressed", it
auto-dispatches via task:

```text
> run bench and see if anything regressed
[agent calls task(subagent_type="bench-runner", ...)]
```

---

## Sub-agent constraints

1. **No recursion**: a sub-agent cannot call the `task` tool. The
   runtime rejects it.
2. **Shared AbortSignal**: Esc cancels the main agent and all running
   sub-agents simultaneously.
3. **Plan mode inherited**: when the parent session is in plan mode,
   the `general-purpose` sub-agent has write tools denied (the other
   sub-agents may already be read-only via their whitelist).
4. **Isolated context**: a sub-agent doesn't see the parent's message
   history — only its own system prompt + the `prompt` argument passed
   to `task()`.
5. **Shared token usage**: sub-agent token use rolls up into the
   parent's total.

---

## Writing `tools` and `disallowedTools`

- `tools: [...]` — whitelist. Only the listed tools are available.
  **Omitting `tools` = full tool set** (minus `task`).
- `disallowedTools: [...]` — blacklist. Applied on top of the whitelist.

A common read-only combo:

```yaml
tools: [readFile, glob, grep, listDir, webFetch, webSearch]
```

Shell access with dangerous-command guards:

```yaml
tools: [readFile, shell, glob]
shellRestrictions: [rm, sudo, npm publish, git push]
```

The full set of tool names (**must be camelCase**, matches the
`toolRegistry` keys in `packages/core/src/tools/index.ts`): `readFile`,
`writeFile`, `edit`, `shell`, `glob`, `grep`, `listDir`, `webSearch`,
`webFetch`, `askUser`, `enterPlanMode`, `exitPlanMode`, `todoWrite`.
The `task` tool is always denied (recursion guard).

---

## When to write a sub-agent — and when not to

**Yes**:

- Repetitive research / verification flows where you keep redoing the same prompt
- Offloading work to a cheaper model (haiku / glm-flash)
- Restricting tools to read-only / shell-only subsets
- Tasks with a fixed output format (bench reports, PR checklists)

**No**:

- One-off tasks (just say it in the main conversation)
- Tasks where the system prompt is nearly identical to general usage —
  use a [skill](./skills.en.md) instead

Rule of thumb: sub-agent ≈ "named callable sub-process"; skill ≈
"embedded prompt template".

---

## Relationship to plugins

A plugin's manifest can declare `agents: "./agents"`; the `.md` files
under that path become available sub-agents. They load identically to
hand-authored user-scope sub-agents, with a `pluginId` tag attached. See
[plugins.en.md](./plugins.en.md).
