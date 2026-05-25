# Hooks

A hook is a shell command a plugin registers against one of ten agent
lifecycle events. The CLI emits an event payload to the hook on
**stdin** as one JSON line; the hook may reply on **stdout** with a
one-line JSON `HookDecision` to influence what the agent does next.

See also: [Authoring a plugin](plugin-authoring.md) ·
[Plugins user guide](plugins.md)

---

## Why shell, not an SDK

Lowest barrier to entry. A bash one-liner or a tiny `node hook.js`
script gets you the same expressiveness as a programmatic API without
any code running inside our process.

This also keeps the surface area small. The CLI doesn't ship a plugin
runtime — just spawns a child, pipes JSON, reads the answer.

---

## The ten events

| Event              | Fires                                                                                                 | Can decide                        | Typical use                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------- |
| `SessionStart`     | At CLI launch (before the UI mounts) — fires once per session even if the user never submits a prompt | no                                | warm up state, prep env                           |
| `UserPromptSubmit` | Just before the user's message hits the model                                                         | **allow / deny / inject context** | inject sprint info, redact secrets, gate by topic |
| `PreToolUse`       | Before any tool is dispatched (writeFile, shell, MCP, sub-agent, …)                                   | **allow / deny / modify args**    | block dangerous paths, rewrite args, audit gate   |
| `PostToolUse`      | After a tool produces a result                                                                        | **modify output**                 | rewrite tool result, append audit metadata        |
| `PreCompact`       | Before context compression runs (proactive threshold or reactive "too long")                          | no                                | checkpoint / persist state before messages trim   |
| `PostCompact`      | After compression finishes                                                                            | no                                | notify, log what was reclaimed                    |
| `SubagentStart`    | When the `task` tool spawns a sub-agent                                                               | no                                | audit which sub-agents fire, record start time    |
| `SubagentStop`     | When a sub-agent finishes (`completed` / `aborted` / `failed`)                                        | no                                | measure sub-agent duration and token usage        |
| `TurnComplete`     | After each round of LLM streaming completes                                                           | no                                | notifications, metrics                            |
| `SessionEnd`       | On CLI shutdown                                                                                       | no                                | flush logs, post a "session done" message         |

`SessionEnd` is fire-and-forget — the CLI exits without waiting for
hooks to complete. Don't put critical operations there; use
`TurnComplete` if you need guaranteed delivery.

---

## Manifest declaration

In your plugin's `plugin.json` (either inline or via a `hooks.json`
path):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "writeFile|edit", // regex against tool name
        "command": "node ${pluginDir}/hooks/lint.js",
        // Optional per-OS overrides. When set, the matching one replaces
        // `command` on that platform. Unset platforms fall back to the
        // base `command` — so a portable default plus a Windows-only
        // override is a common pattern.
        "commandWindows": "node \"${pluginDir}/hooks/lint.js\"",
        "commandDarwin": "node ${pluginDir}/hooks/lint.js", // rarely needs to differ
        "commandLinux": "node ${pluginDir}/hooks/lint.js",
        "timeout": 5000, // ms (default 5000, cap 30000)
        "description": "Lint before writing",
        "failurePolicy": "allow", // or "block" (default "allow")
      },
    ],
    "UserPromptSubmit": [{ "command": "${pluginDir}/hooks/inject-context.sh" }],
  },
}
```

**Why ship all three platforms**: plugins end up installed on Windows /
Linux / macOS. A `bash foo.sh` default silently breaks for Windows
users. Make the base `command` a portable form (e.g. `node script.js`),
then add a platform-specific `commandWindows` / `commandDarwin` /
`commandLinux` only where one OS genuinely needs different syntax
(path quoting, PowerShell idiom, `.cmd` suffix). Don't ship plugins
that only work on your dev machine.

Or pull it into a separate file:

```jsonc
{ "hooks": "./hooks/hooks.json" }
```

with `./hooks/hooks.json` containing the same `{ PreToolUse: [...], ... }`
shape directly (no outer `hooks` wrapper).

---

## Variable expansion in `command`

| Variable           | Expands to                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `${pluginDir}`     | Plugin install dir (the versioned cache dir; wiped on reinstall / upgrade)                                                                                      |
| `${pluginDataDir}` | The plugin's **persistent data dir** (`~/.x-code/plugins/data/<id>/`). Survives uninstall+reinstall and version upgrades — use for indexes, caches, user prefs. |
|                    | Auto-`mkdir -p` on first substitution, so the hook can write there immediately.                                                                                 |
| `${cwd}`           | Current working directory at event-emit time                                                                                                                    |
| `${homedir}`       | `os.homedir()`                                                                                                                                                  |
| `${sep}`           | OS path separator (`\` on Windows, `/` elsewhere)                                                                                                               |
| `${env:NAME}`      | `process.env.NAME` (empty string if unset)                                                                                                                      |

Unknown variables are left **verbatim** in the command string — a typo
like `${plugindir}` shows up as a "file not found" shell error, not as
a silent empty substitution. That's deliberate so typos surface.

**`${pluginDir}` vs `${pluginDataDir}`**: the former is where the
plugin's code lives (gone on uninstall / upgrade), the latter is where
its runtime data lives (preserved across versions). A "learned coding
style" cache should write to `${pluginDataDir}` so the user's history
isn't wiped on upgrade.

---

## Stdin payload

Every hook receives a single JSON line on stdin. Top-level shape:

```jsonc
{
  "event": "PreToolUse", // event name
  "session": {
    // every event has this
    "cwd": "/abs/path/to/project",
    "modelId": "anthropic:claude-sonnet-4-6",
  },
  "plugin": {
    // identifies which plugin's
    "id": "linear@anthropic-marketplace", // hook is running
    "dir": "/abs/.x-code/plugins/cache/anthropic-marketplace/linear/1.2.0",
  },

  // Event-specific extras flattened in at top level:
  "tool": {
    // PreToolUse, PostToolUse
    "name": "writeFile",
    "args": { "path": "src/foo.ts", "content": "..." },
    "callId": "call_abc123",

    // PostToolUse only:
    "output": "wrote 42 bytes",
    "isError": false,
  },
  "prompt": "Refactor X to do Y", // UserPromptSubmit only
  "turn": 3, // TurnComplete only
  "tokenUsage": {
    // TurnComplete only, also SubagentStop
    "inputTokens": 4321,
    "outputTokens": 567,
    "totalTokens": 4888,
  },

  // PreCompact / PostCompact
  "trigger": "proactive", // or "reactive" (i.e. "prompt too long" recovery)
  "messageCount": 87, // messages before (PreCompact) or after (PostCompact)
  "tokenEstimate": 184_000, // PreCompact only
  "summary": "...", // PostCompact only — empty string means light-compact path (no LLM summary)

  // SubagentStart / SubagentStop
  "agent": {
    "name": "code-reviewer",
    "description": "review the diff",
    "prompt": "<full prompt sent to sub-agent>", // SubagentStart only
  },
  "durationMs": 12_345, // SubagentStop only
  "outcome": "completed", // SubagentStop only: completed / aborted / failed
}
```

---

## Stdout decision

A hook may reply with a single JSON line on stdout. Empty stdout = the
default `allow` (most fire-and-forget hooks output nothing). Anything
unparseable as JSON is treated as `allow` plus a debug-log breadcrumb.

```jsonc
// Default — agent proceeds normally
{ "decision": "allow" }

// Optional context to attach (UserPromptSubmit / PostToolUse)
{ "decision": "allow", "context": "Current sprint: Sprint 42" }

// Stop the agent from doing the thing
{ "decision": "deny", "reason": "Editing prod config is forbidden" }

// Rewrite the tool args (PreToolUse) or output (PostToolUse)
{ "decision": "modify", "args": { "path": "/safer/path" } }
{ "decision": "modify", "output": "[redacted]" }
{ "decision": "modify", "context": "Sprint 42 in progress" }
```

What gets applied:

| Event                                                                                                            | `deny`                                                   | `modify.args`                                      | `modify.output`                         | `context`                       |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- | --------------------------------------- | ------------------------------- |
| `UserPromptSubmit`                                                                                               | blocks the prompt with a synthetic assistant message     | —                                                  | —                                       | prepended into the user message |
| `PreToolUse`                                                                                                     | replaces the tool result with a "denied by hook" message | replaces the input args the tool actually receives | —                                       | (ignored)                       |
| `PostToolUse`                                                                                                    | (deny ignored — too late)                                | —                                                  | replaces the tool result the model sees | (ignored)                       |
| `SessionStart` / `PreCompact` / `PostCompact` / `SubagentStart` / `SubagentStop` / `TurnComplete` / `SessionEnd` | (no decisions — stdout ignored)                          | —                                                  | —                                       | —                               |

When multiple hooks match the same event:

- **Decision events** run serially in registration order. A `deny`
  short-circuits the remaining hooks.
- **Fire-and-forget events** run in parallel.
- `modify` decisions stack: later modifies override earlier ones.

---

## Failure handling

A hook that crashes, times out, or exits non-zero is treated as `allow`
by default and a warning lands in `~/.x-code/logs/debug.log` (set
`DEBUG_STDOUT=1` to enable that log, or use `xc --plugin-debug` which
mirrors only `plugins.` / `hooks.` / `marketplace.` tagged lines to
stderr — much quieter than the firehose).

Set `"failurePolicy": "block"` on the entry to flip that for one hook —
non-zero exit then becomes a `deny`. Use this only for gating hooks
the user actively wants strict; the default-allow stance exists to
ensure a broken hook never wedges the agent.

The 30-second timeout cap is a hard ceiling, not a default. Default is
5 seconds. Authors who need longer should split work into background
processes that the hook kicks off and returns immediately.

### Confirming a hook actually ran

The hook subprocess is spawned with `stdio: 'pipe'` — execa parses its
stdout as the decision JSON, and stderr is consumed for error reporting
— so anything the hook writes via `console.log` / `process.stderr.write`
is invisible to you. The way to verify is the debug log:

- **`hooks.exec-ran <pluginId> <event>: decision=<allow|deny|modify>`** —
  emitted once per successful hook run, regardless of decision
- `hooks.exec-timeout` / `hooks.exec-nonzero` / `hooks.exec-error` —
  the failure paths
- `hooks.bus-error` — orchestration-layer errors
- `hooks.matcher-invalid` — bad matcher regex

`xc --plugin-debug` mirrors these to stderr in real time; alternately
run a session and grep `~/.x-code/logs/debug.log` afterwards. Most
common reasons a hook doesn't fire: (a) plugin not enabled (`/plugin
list`), (b) you didn't refresh after install (`/plugin refresh`), (c)
matcher regex doesn't match the tool name (tools are camelCase, e.g.
`writeFile`, `edit`).

---

## Abort behaviour

Esc / Ctrl+C during a slow hook propagates via `AbortSignal` through
execa's `cancelSignal` and SIGKILLs the child process. Same machinery
the shell tool uses. Hooks don't need to do anything special — they
just get killed.

---

## End-to-end example: lint before writes

```js
// hooks/lint.js — fired on PreToolUse for writeFile|edit
const data = require('fs').readFileSync(0, 'utf-8') // read stdin
const event = JSON.parse(data)
const filePath = event.tool.args.path

if (!filePath.endsWith('.ts')) {
  console.log(JSON.stringify({ decision: 'allow' }))
  process.exit(0)
}

const { execSync } = require('child_process')
try {
  execSync(`eslint --quiet "${filePath}"`, { stdio: 'pipe' })
  console.log(JSON.stringify({ decision: 'allow' }))
} catch (e) {
  console.log(
    JSON.stringify({
      decision: 'deny',
      reason: `Lint failed:\n${e.stdout?.toString() || e.message}`,
    }),
  )
}
```

Manifest:

```jsonc
{
  "name": "ts-lint-gate",
  "version": "0.1.0",
  "hooks": {
    "PreToolUse": [{ "matcher": "writeFile|edit", "command": "node ${pluginDir}/hooks/lint.js" }],
  },
}
```

The agent now sees a `deny` whenever it tries to write a TypeScript
file that fails lint — and the deny's `reason` shows up in the tool
result, so the model can see why and adjust.

---

## Sub-agent behaviour

Sub-agents inherit the parent's `HookBus`, so `PreToolUse` /
`PostToolUse` fire for tool calls inside a sub-agent run. This is
intentional — plugin authors wanting to audit ALL model behaviour can
do so. `SessionStart` / `SessionEnd` only fire for the outer session,
not per sub-agent.

Beware recursion: if a hook itself invokes `xc` or another agent, its
own tool calls will also fire `PreToolUse`. Keep hook logic narrow,
and prefer the `matcher` regex to constrain which tools trigger them.

---

## Suppressing hooks for a session

```bash
xc --no-hooks            # plugins still load, hooks just don't run
xc --no-plugins          # nuclear option: no plugin loading at all
```

Useful for diagnosing whether a hook is the cause of a hang or
slowdown.
