# Background Shell Sessions

X-Code CLI manages long-running and interactive commands as shell sessions. A normal command waits for an initial window; if it is still running, the agent receives a `shellId` and can continue reading output, send input, or stop the managed process tree.

中文版：[shell-sessions.md](./shell-sessions.md)

## Default behavior

- `shell` waits for 10 seconds by default. Commands that finish within that window return their complete result normally.
- A command still running after 10 seconds becomes a background session and returns a `shellId`.
- `yieldTimeMs: 0` returns a background session immediately; other initial wait windows can also be specified.
- `timeout` is an optional hard runtime limit. Omitting it means no hard timeout.
- `cwd` is resolved relative to the current session's project directory.
- `maxOutputTokens` limits model-facing output, not process runtime.

The legacy `runInBackground: true` flag remains compatible, but new tool calls should use `yieldTimeMs: 0`.

## Inspecting and stopping sessions

The interactive CLI provides two commands:

| Command            | Effect                                                               |
| ------------------ | -------------------------------------------------------------------- |
| `/ps`              | List running background terminals, elapsed time, and recent output   |
| `/stop [shell-id]` | Stop one session, or all background terminals when the ID is omitted |

The agent manages sessions through two companion tools:

- `shellOutput` reads output produced since the previous read. An empty read waits for up to 5 seconds by default.
- `killShell` terminates one session and confirms whether its managed process tree exited.

A `shellId` is temporary to the current CLI session. Do not persist it for reuse in another session or script.

## Interactive commands

Start programs that require terminal input with `tty: true`. X-Code CLI uses ConPTY on Windows and a PTY on macOS / Linux. The agent can send normal input or control characters through `shellOutput.chars`; for example, `\u0003` represents Ctrl+C. `cols` and `rows` must be provided together when resizing the terminal.

A non-TTY session rejects ordinary character input. Sending `\u0003` to it terminates the managed process tree.

## Sub-agents

A sub-agent that can use `shell` automatically receives `shellOutput` and `killShell` so it can manage commands it starts. A custom sub-agent therefore cannot allow `shell` while denying either companion through `disallowedTools`; that definition is rejected during loading.

See [sub-agents.en.md](./sub-agents.en.md) for tool and permission configuration.

## Practical guidance

- Builds, tests, and development servers that may exceed 10 seconds need no special background flag.
- Use `yieldTimeMs: 0` when a service should start and return immediately.
- Use `tty: true` when a command needs prompts, keystrokes, or a dynamic terminal.
- Stop services after verification when they are no longer needed. X-Code CLI also cleans up managed process trees during shutdown.
