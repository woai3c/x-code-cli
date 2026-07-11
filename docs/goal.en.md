# Durable goal loops with `/goal`

`/goal` is for tasks that require the agent to keep working, verify the result, and repair failures until an explicit completion condition is met. Unlike a normal conversation, a goal automatically starts the next turn without requiring the user to repeatedly say “continue.”

Good `/goal` tasks include:

- Fixing a test suite until its test command passes
- Implementing a feature that can be checked by a build, lint, test, or script
- Producing files with verifiable contents or repository state
- Engineering work that needs several investigate, implement, verify, and repair cycles

Normal conversation is usually better for subjective questions and open-ended discussion. Users do not need to write a verifier: when no verification option is provided, the built-in read-only `goal-verifier` derives completion requirements from the natural-language objective, referenced artifacts, repository instructions, and current state.

## Quick start

```text
/goal Fix every failing test in the current project and keep going until the test suite passes
```

The agent derives the full test entry point from the objective and project structure, then keeps repairing failures. On a completion request, the built-in verifier independently derives all requirements and checks current evidence. Findings and required fixes are fed into the next turn; the goal becomes `complete` only after verification passes.

Outer turns and goal-level tokens are both unlimited unless `--max-turns` or `--token-budget` is explicitly specified.

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
| `--max-turns <n>`                | Limit outer goal turns; unlimited by default                                                      |
| `--token-budget <n>`             | Limit total tokens consumed since this goal was created                                           |

Options can be combined. Explicit verifiers run in command-line order and the first failure stops that verification run. After they pass, the built-in `goal-verifier` still audits whether those checks cover the full objective. With `--confirm`, the user is prompted after every automatic check passes.

### Shell verifiers

```text
/goal Implement configuration loading --verify "pnpm typecheck" --verify "pnpm test packages/core/tests/config.test.ts" --max-turns 12
```

Shell verifiers run in the current working directory, have a 120-second default timeout, and follow the normal shell permission policy. Quote commands containing spaces and escape nested quotes for the current terminal and `/goal` argument parser.

### Sub-agent verifiers

```text
/goal Fix the login flow security issue --verifier-agent goal-verifier --verifier-prompt "Read-only review the changes, tests, and permission boundaries; confirm the issue is fully fixed" --max-turns 10
```

`goal-verifier` is the built-in read-only verification agent and runs automatically for every goal. It independently derives requirements from the original objective, referenced artifacts, repository instructions, and current state, then returns structured findings and required fixes without editing files. `--verifier-agent` adds a custom check; it is not required for basic completion.

### User confirmation

```text
/goal Analyze these errors and produce a root-cause report --confirm --max-turns 6
```

Use `--confirm` when automatic checks cannot fully assess subjective quality. The semantic verifier first checks every requirement with objective evidence and leaves final subjective approval to the confirmation gate. Selecting `No` continues the goal and selecting `Yes` completes it.

## Control the current goal

| Command                       | Purpose                                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `/goal` or `/goal status`     | Show the objective, status, turns, token budget, and latest verification result            |
| `/goal pause`                 | Pause an active goal; this remains available during execution and permission prompts       |
| `/goal resume`                | Resume a `paused`, `blocked`, or `max_turns` goal                                          |
| `/goal resume --max-turns +3` | Add three turns to an existing explicit limit; use an absolute value for an unlimited goal |
| `/goal steer <instruction>`   | Add guidance for the next turn and continue the same goal                                  |
| `/goal edit <new objective>`  | Change the current objective                                                               |
| `/goal edit --max-turns <n>`  | Change the turn limit                                                                      |
| `/goal verify`                | Run the configured verification now; continue repairing after failure                      |
| `/goal cancel`                | Cancel the goal and stop automatic execution                                               |
| `/goal clear`                 | Remove current goal state so a new goal can be created                                     |

`/goal status` only reads state. It neither starts new work nor pauses a goal that is already running in the background. If the status is `active`, verifier or repair output may continue after the status result; use `/goal pause` first when you want execution to stop after viewing it. `pause`, `cancel`, and `clear` interrupt in-flight goal work and release pending interactions. Pressing `Esc` during an active goal pauses it; use `/goal resume` to continue later.

## States and stop conditions

| State            | Meaning                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `active`         | Automatically executing                                                                        |
| `paused`         | Paused by the user and resumable                                                               |
| `blocked`        | Repeatedly blocked by the same external condition; resumable after intervention                |
| `complete`       | Every verifier and optional user confirmation passed                                           |
| `max_turns`      | Turn limit reached; a progress summary is produced and the goal can resume with a larger limit |
| `budget_limited` | Goal token budget reached                                                                      |
| `usage_limited`  | Provider or account usage limit reached                                                        |
| `cancelled`      | Cancelled by the user                                                                          |
| `failed`         | An unrecoverable error occurred                                                                |

The runner stops as `blocked` when the same external blocker is reported three consecutive times and stops at user-configured turn or token limits. Repeated verifier failures trigger progressively stronger strategy correction without weakening acceptance. Users can pause, cancel, or press Esc to interrupt an unlimited goal at any time.

## Recommendations

- State the objective, scope, and prohibitions in natural language; the system derives the acceptance requirements.
- Deterministic tests, builds, and check scripts are useful additional evidence, but they do not replace a semantic audit of the full objective.
- Shell verifiers should inspect results rather than modify the project, so verification does not change the state it evaluates.
- Set `--max-turns` or `--token-budget` when cost control is needed; omitting them means unlimited.
- Goal state is saved with the session. After resuming a historical session, run `/goal status` before deciding whether to `/goal resume`.
