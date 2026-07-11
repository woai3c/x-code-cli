# Durable goal loops with `/goal`

`/goal` is for tasks that require the agent to keep working, verify the result, and repair failures until an explicit completion condition is met. Unlike a normal conversation, a goal automatically starts the next turn without requiring the user to repeatedly say “continue.”

Good `/goal` tasks include:

- Fixing a test suite until its test command passes
- Implementing a feature that can be checked by a build, lint, test, or script
- Producing files with verifiable contents or repository state
- Engineering work that needs several investigate, implement, verify, and repair cycles

Use normal conversation for subjective questions, open-ended discussion, or work without a verifiable finish condition. A goal without a verifier or explicit user confirmation cannot complete; it stops as `blocked` instead of looping indefinitely.

## Quick start

```text
/goal Fix all unit tests --verify "pnpm test" --max-turns 10 --token-budget 100000
```

The agent keeps working and runs `pnpm test` when it believes the objective is complete. A failed verifier is fed into the next turn for repair. The goal becomes `complete` only after verification passes.

The default limit is 20 outer goal turns. There is no goal-level token limit unless `--token-budget` is specified.

## Create a goal

```text
/goal <objective> [options]
```

| Option                           | Purpose                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------- |
| `--verify "<command>"`           | Run a shell verifier; exit code 0 means success                                                   |
| `--verifier-agent <name>`        | Use a read-only sub-agent as an independent verifier; the built-in `goal-verifier` is recommended |
| `--verifier-prompt "<criteria>"` | Set the sub-agent acceptance criteria; it may appear before or after its `--verifier-agent`       |
| `--confirm`                      | Require explicit user confirmation before completion                                              |
| `--max-turns <n>`                | Limit outer goal turns; defaults to 20                                                            |
| `--token-budget <n>`             | Limit total tokens consumed since this goal was created                                           |

Options can be combined. Multiple verifiers run in command-line order and the first failure stops that verification run. With `--confirm`, the user is prompted only after every configured verifier passes.

### Shell verifiers

```text
/goal Implement configuration loading --verify "pnpm typecheck" --verify "pnpm test packages/core/tests/config.test.ts" --max-turns 12
```

Shell verifiers run in the current working directory, have a 120-second default timeout, and follow the normal shell permission policy. Quote commands containing spaces and escape nested quotes for the current terminal and `/goal` argument parser.

### Sub-agent verifiers

```text
/goal Fix the login flow security issue --verifier-agent goal-verifier --verifier-prompt "Read-only review the changes, tests, and permission boundaries; confirm the issue is fully fixed" --max-turns 10
```

`goal-verifier` is the built-in read-only verification agent. It checks the objective, repository state, changes, and evidence and returns a structured decision without editing files. It is useful when one command cannot decide completion but the acceptance criteria are still concrete.

### User confirmation

```text
/goal Analyze these errors and produce a root-cause report --confirm --max-turns 6
```

Use `--confirm` when automatic checks cannot fully assess quality. Selecting `No` continues the goal; selecting `Yes` completes it. Confirmation can be the only verifier or the final gate after automatic verifiers.

## Control the current goal

| Command                       | Purpose                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `/goal` or `/goal status`     | Show the objective, status, turns, token budget, and latest verification result              |
| `/goal pause`                 | Pause an active goal; this remains available during execution and permission prompts         |
| `/goal resume`                | Resume a `paused`, `blocked`, or `max_turns` goal                                            |
| `/goal resume --max-turns +3` | Add three turns before resuming; an absolute value such as `--max-turns 12` is also accepted |
| `/goal steer <instruction>`   | Add guidance for the next turn and continue the same goal                                    |
| `/goal edit <new objective>`  | Change the current objective                                                                 |
| `/goal edit --max-turns <n>`  | Change the turn limit                                                                        |
| `/goal verify`                | Run the configured verification now; continue repairing after failure                        |
| `/goal cancel`                | Cancel the goal and stop automatic execution                                                 |
| `/goal clear`                 | Remove current goal state so a new goal can be created                                       |

`pause`, `cancel`, and `clear` interrupt in-flight goal work and release pending interactions. Pressing `Esc` during an active goal pauses it; use `/goal resume` to continue later.

## States and stop conditions

| State            | Meaning                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| `active`         | Automatically executing                                                                                 |
| `paused`         | Paused by the user and resumable                                                                        |
| `blocked`        | Missing verification or repeatedly blocked by the same external condition; resumable after intervention |
| `complete`       | Every verifier and optional user confirmation passed                                                    |
| `max_turns`      | Turn limit reached; a progress summary is produced and the goal can resume with a larger limit          |
| `budget_limited` | Goal token budget reached                                                                               |
| `usage_limited`  | Provider or account usage limit reached                                                                 |
| `cancelled`      | Cancelled by the user                                                                                   |
| `failed`         | An unrecoverable error occurred                                                                         |

The runner also stops as `blocked` when the same external blocker is reported three consecutive times, and stops at configured turn or token limits. These gates prevent unbounded execution.

## Recommendations

- Separate what must be done from how completion is proved: put scope in the objective and acceptance in verifiers.
- Prefer deterministic tests, builds, and check scripts; add `goal-verifier` when semantic judgment is necessary.
- Shell verifiers should inspect results rather than modify the project, so verification does not change the state it evaluates.
- Set a practical `--max-turns`, and add `--token-budget` for longer or cost-sensitive work.
- Goal state is saved with the session. After resuming a historical session, run `/goal status` before deciding whether to `/goal resume`.
