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

Five ship in the box (plus the opt-in `browser`, see below):

| Name              | Best for                                                                       | Tool whitelist                                                                       |
| ----------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `explore`         | Searching a large codebase for a symbol / keyword / call chain; read-only      | `readFile`, `glob`, `grep`, `listDir`, `shell` (restricted)                          |
| `general-purpose` | Catch-all research / multi-step tasks that don't fit elsewhere                 | default full tool set (minus `task`)                                                 |
| `plan`            | Given a task, explore the code and produce an implementation plan              | `readFile`, `glob`, `grep`, `listDir` (read-only)                                    |
| `code-reviewer`   | Reviewing diffs / PRs                                                          | `readFile`, `glob`, `grep`, `listDir`, `shell` (restricted)                          |
| `goal-verifier`   | Read-only independent verification for `/goal` completion, returns strict JSON | `readFile`, `glob`, `grep`, `listDir`, `shell` (restricted, read-only commands only) |

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

## Browser automation

`browser` is a sixth built-in sub-agent, but it is **not registered by
default**. It drives a real browser (powered by
[@playwright/mcp](https://github.com/microsoft/playwright-mcp)) for tasks that
`webFetch` / `webSearch` can't handle: logged-in pages, JS-rendered SPAs, form
filling, multi-step flows. It works primarily from the **accessibility tree**
(text-based, so it works across every provider, including non-multimodal
models); on vision-capable models it can also screenshot the page for
canvas / maps / charts and other visual-only content. A text-only model can
use a configured vision-capable provider to receive a text description.

Lightweight visual checking is independent: the main agent can use
`browserVisualCheck` for local web apps by default, without `/browser on`.

**Enable interactive Browser Use** (either way):

- At runtime: `/browser on` (hot — no restart; `/browser off` disables it and
  leaves the shared browser available when visual checks are still on)
- Config: `"browser": { "enabled": true }` in `~/.x-code/config.json`

Automatic local visual checks default to on. Toggle them independently with
`/browser check-on` / `/browser check-off`, or set
`"browser": { "visualCheck": false }`.

**Prerequisites**: Node and Chrome installed locally; no Chrome extension is
required. The first use launches a separate managed browser through a pinned,
tested `@playwright/mcp` release (tens of seconds). Optional config:

```json
{
  "browser": {
    "enabled": true,
    "visualCheck": true,
    "headless": false,
    "browser": "chrome",
    "viewport": "1280,800",
    "vision": true
  }
}
```

> `headless` defaults to `false` (a visible window, so you can watch); `browser`
> defaults to `chrome` (your installed Google Chrome) and also accepts
> `chromium` / `msedge` / `firefox` / `webkit`. `vision` controls the extra
> coordinate-based controls, while screenshots themselves remain available.

Choosing `chrome` selects the installed Chrome executable, not the profile of
your everyday Chrome window. Playwright launches a separate managed profile;
it can retain its own cookies and local storage between runs for the same
workspace, but it does not attach to your existing tabs or normal Chrome
cookies. No extension is required. If two `xc` instances in the same workspace
try to use that persistent profile, the first browser owner wins; the other
instance reports the existing session before launching Chrome instead of
silently switching to a temporary profile and losing signed-in state. X-Code
reclaims a lease left by a crashed process, while Chrome's own profile lock
remains the final fallback.

The system prompt asks the model to choose between two paths:

- After visual web changes, the default-enabled `browserVisualCheck` opens a
  local `localhost` page in a temporary tab and returns one viewport screenshot
  plus a compact console-error summary. It verifies the final URL before and
  after capture, rejects external redirects, closes the temporary tab by its
  stable Playwright Page identity, then restores the prior Page through the MCP
  tab API. Incomplete close/restore cleanup is reported explicitly. Navigation
  snapshots never enter model context, and the image is replaced with a short
  placeholder after the model has inspected it. Raw screenshot base64 is not written to the project's
  `.x-code/sessions/*.jsonl`; occasional MCP output files live only under the
  current system temp directory and are left to the OS or cache cleaners. Three
  consecutive checks without a file modification trip a circuit breaker; a
  successful edit resets it.
- Clicking, typing, authentication, and other multi-step flows require
  `/browser on` and use the interactive `browser` sub-agent.

This is a model decision, not a deterministic post-build hook, so it can be
skipped. You can explicitly ask for a visual check when verification matters.

**Isolation**: the full browser tool set (navigate / snapshot / click …) remains
private to the `browser` sub-agent. The main loop only exposes the narrow
`browserVisualCheck` interface. Both paths reuse the same stateful browser
process and serialize complete browser tasks so their shared current tab cannot
interfere. It closes on CLI exit or when both features are off; if you close it
yourself, the next task reconnects automatically. A visual check sends the
captured local UI image to the active vision model, or—after a progress/result
notice—to a configured vision-caption model when the active model is text-only.
Screenshots, page content, and console output are always treated as untrusted
data, never instructions; common secrets and terminal control sequences are
scrubbed from console and browser-startup diagnostics.

The `localhost` restriction covers only the top-level page and its final
redirects; it is not a network sandbox. The local application can still load
CDNs, APIs, or other external resources according to its own code. Enforce
offline behavior in the app or test environment when that is required.

---

## Writing custom sub-agents

Drop a `.md` file under either path:

| Scope   | Path                             |
| ------- | -------------------------------- |
| User    | `~/.x-code/agents/<name>.md`     |
| Project | `<cwd>/.x-code/agents/<name>.md` |

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

`name` and `description` are required. Every optional field shown above is
also type-checked when present; an invalid file is skipped with a warning.

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
   **all** sub-agents have their write tools (`writeFile` / `edit` /
   `shell`) denied — `general-purpose` included.
4. **Isolated context**: a sub-agent doesn't see the parent's message history.
   It receives its definition prompt, project knowledge, relevant recalled
   memory, and the `prompt` argument passed to `task()`.
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
`webFetch`, `askUser`, `enterPlanMode`, `exitPlanMode`, `todoWrite`,
`shellOutput`, `killShell`. The `task` tool is always denied (recursion
guard), and `memorySearch` is registered for the root agent only — sub-agents
never receive it.

When `shell` is allowed, the runner automatically adds `shellOutput` and
`killShell` so background commands remain manageable. A definition that
denies either companion through `disallowedTools` is rejected. See
[shell-sessions.en.md](./shell-sessions.en.md).

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
