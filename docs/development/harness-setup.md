# Human-owned harness setup

This guide owns external or sensitive setup that repository files cannot complete safely. It does not authorize changes to GitHub settings, credentials, paid services, releases, or production systems.

## GitHub PR governance

Status: `SETUP REQUIRED` for enforced Ready/merge governance. The repository already contains `.github/workflows/pr-check.yml` and `.github/pull_request_template.md`; public GitHub history shows that PR Check workflows have run. Branch rules, required reviews, current check requirements, and fork behavior were not verified.

A repository administrator should:

1. Decide the human review and merge policy for `main`; do not let this guide silently choose an approval count or bypass policy.
2. Configure a branch rule or ruleset that requires a PR and the intended current check contexts. The workflow currently defines `Lint & Format`, `Type Check`, `Test` on Ubuntu/macOS/Windows, `Windows Native Source`, `Package Check`, and `Commit Message Check`.
3. Open a harmless Draft PR from a repository branch. Confirm the template appears, each expected job starts, a failed/cancelled/timed-out job blocks the selected boundary, and Draft is not treated as Ready.
4. If outside contributions are supported, repeat from a fork and verify token permissions, dependency installation, and secret isolation. The PR workflow has read-only contents permission and uses only the automatic `GITHUB_TOKEN`; confirm organization/repository policy agrees.
5. Record the exact required check contexts and review rule in the repository's maintained governance owner, then update the MR/PR CI and Draft/Ready rows in [`agent-workflow.md`](agent-workflow.md).

Fallback: keep the PR Draft and have the maintainer manually account for every job and acceptance decision. Consequence: GitHub may still allow a merge that bypasses the documented workflow. Disable or rollback by reverting only the external rule change after recording why; repository workflow files are unaffected unless they were separately changed.

## Real-model E2E and live-provider verification

Status: `SETUP REQUIRED`. The suite is repository-local, but provider selection, credentials, data exposure, cost, cadence, and the lifecycle boundary it blocks are human decisions.

Before first use, a maintainer should:

1. Choose an approved provider/model and budget. Use only the secret name already supported by `packages/cli/tests/e2e/framework/models.ts`, such as `DEEPSEEK_API_KEY`, or the paired `OPENAI_COMPATIBLE_API_KEY` and `OPENAI_COMPATIBLE_BASE_URL`; never commit a value.
2. Review [`packages/cli/tests/e2e/README.md`](../../packages/cli/tests/e2e/README.md), the selected scenarios, and their prompts/tool permissions. Most scenarios use isolated temporary directories and `X_CODE_HOME`, but the child process inherits the launching environment and some scenarios run with `--trust`.
3. Run from a clean shell, disposable account, container, or VM whose environment contains only the intended provider/search credentials and required operating-system variables. Do not expose unrelated tokens, private repository data, production accounts, or user credentials merely to run E2E.
4. Start with `pnpm test:e2e --list`, then one low-risk scenario using `pnpm test:e2e --filter <scenario> --model <approved-model> --keep-tmp`. Inspect exit status, tool calls, files, session JSONL, token usage, and retained temporary state before broadening scope.
5. Choose and record the E2E placement policy: targeted/full per PR, promotion, schedule, pre-release, or a documented combination. Name the suite, trigger, tested revision/candidate, environment/data, expected cost and duration, result owner, blocking target, artifact retention, and failure return loop.
6. Verify the chosen path on a non-production change. Update the live-runtime and Full E2E rows in [`agent-workflow.md`](agent-workflow.md) only when the complete named path has representative evidence.

Fallback: use fake-provider, Package, and PTY tests plus Human Local Acceptance. For behavior that inherently depends on a live model/provider, keep the PR Draft until a maintainer records either E2E evidence or explicit risk acceptance. Consequence: model/tool orchestration remains unverified by an Agent runtime.

Remove E2E credentials from the local environment or secret store to disable the path. Delete retained temporary directories and ignored `.state` artifacts only after preserving any evidence required for an active failure investigation.

## Deliberately unselected automation

Independent AI review and automatic post-merge knowledge audit are `NOT CONFIGURED`. Before adding either, maintainers must choose the runner and model provider, define untrusted-input handling and data disclosure, scope credentials and write permissions, set cost/concurrency/failure behavior, and verify that proposed knowledge changes use a separate human-reviewed PR. Until then, use human technical review or a clearly separate manual reviewer, and capture confirmed knowledge in the active change.
