# Agent development workflow

This is the repository-owned operating contract for human-in-the-loop changes. `AGENTS.md` remains the concise instruction entrypoint; this document owns the delivery stages, evidence rules, and Harness Capability Report. Product behavior remains owned by source, tests, maintained product documentation, and explicit maintainer decisions.

## Daily path

```text
Specify -> Explore -> Plan <-> Human Plan Review -> Implement <-> Local Fast Verification
        -> Targeted Runtime Verification <-> Human Local Acceptance
        -> Create or mark PR Ready <-> Independent review + PR CI -> Merge
```

A Draft PR may be opened earlier for plan review, early CI, or collaboration. Continuous Knowledge Capture applies throughout. A failed plan review, check, runtime flow, acceptance decision, review, or CI gate returns to the relevant earlier stage; after a fix, rerun affected local checks, update the PR, and rerun every applicable PR gate. Merge and release remain separate human-authorized actions.

## Define and plan the work

Use the user request, GitHub Issue, or Draft PR as the work-definition owner. Before implementing non-trivial work, record:

- goal, affected users or systems, constraints, and non-goals;
- success and acceptance criteria that do not depend on the proposed implementation;
- affected packages, public interfaces, state, and compatibility surfaces;
- risks, assumptions, `Unknown` questions, and the human able to resolve them;
- the proposed approach, meaningful alternatives, and verification plan.

Use the full path when intent is ambiguous, a public interface or architecture boundary changes, persisted data or security is involved, cross-platform behavior is affected, external effects are possible, or verification needs coordination. The requesting maintainer reviews the plan in the active agent conversation, Issue, or Draft PR before implementation. Silence is not approval, and plan approval does not authorize commits, pushes, releases, production access, credentials, or destructive actions.

The fast path is limited to changes that are small, reversible, unambiguous, free of consequential product, architecture, security, data, compatibility, money, or production decisions, and covered by a proportionate existing check. Keep the plan inline, but do not skip relevant verification, truthful handoff, or human acceptance when judgment is still required.

## Agent verification

Start with the narrowest relevant evidence from the repository root:

1. Focused regression: `pnpm test <path-or-pattern>`.
2. Affected type and static checks: `pnpm typecheck`, `pnpm lint:check`, and `pnpm format:check` as applicable. `pnpm lint` mutates files and is for an intentional fix, not a read-only check.
3. Build after every core-source edit: `pnpm build`. The CLI imports `packages/core/dist/`.
4. Before Ready for Review, run `pnpm run ci` unless the task documents why a narrower gate is proportionate or why a required check could not run.

`pnpm test` builds and runs the Unit, Fault, Package, and PTY projects. GitHub PR CI additionally runs tests on Ubuntu, macOS, and Windows, checks the Windows native helper, package contents, formatting, lint, types, and commit messages. A failed, cancelled, timed-out, missing, or unexpectedly skipped required job is not success.

### Targeted CLI runtime verification

After local fast checks, exercise the affected CLI behavior in the closest safe runtime:

- For startup, packaging, or argument behavior, build and invoke `node packages/cli/dist/cli.js --version` or `--help`, then use a focused package or PTY test for the changed flow.
- Prefer the existing fake-provider and isolated temporary-directory fixtures when they cover the acceptance criterion.
- Use the real-model E2E runner only under the setup and cost boundary below; Unit tests do not replace a required live-provider observation.

Record the tested commit, or explicitly say the worktree was uncommitted. Include the OS and Node version, exact command and input, initial or isolated state, expected observable predicate, exit status, stdout/stderr or artifact evidence, side effects, and material exclusions. A screenshot or log without this provenance is supporting material, not proof by itself.

### Full E2E placement

`packages/cli/tests/e2e/` is a real-LLM suite with targeted filters, temporary scenario directories, resumable state, and documented token cost. It is not in `.github/workflows/pr-check.yml`; no scheduled or pre-release E2E trigger is configured. The maintainer has not selected a binding automated cadence.

Until that decision is recorded:

- do not call full E2E a PR gate or claim it ran;
- for a change whose acceptance depends on live model, tool, search, permission, or multi-turn behavior, keep the PR Draft until the maintainer records either the applicable targeted/full E2E evidence or an explicit fallback and accepted confidence consequence;
- report unexecuted E2E as `NOT EXECUTED`, including the missing credential or cost approval, the behavior left unverified, and the manual fallback;
- follow [`harness-setup.md`](harness-setup.md) before supplying credentials or choosing a cadence.

## Human acceptance and PR review

After applicable Agent Verification, the requesting maintainer or named delegate decides whether the result satisfies the actual goal and acceptance criteria. Record Human Local Acceptance in the active conversation, Issue, or PR. An implementing agent cannot accept its own interpretation. Rejection returns to implementation and all affected verification stages.

Open a Draft PR when work or plan review is still in progress. Mark it Ready only when:

- non-trivial scope and plan have a recorded human decision;
- Local Fast Verification passed and Targeted Runtime Verification is passed, not applicable, or explicitly accounted for;
- Human Local Acceptance is recorded, or an established repository policy is cited for a routine fast-path outcome;
- risks, deviations, unknowns, E2E status, and evidence exclusions are visible in the PR template.

Once Ready, complete both applicable PR CI and technical review. An implementing agent's self-review is not independent AI review. Independent AI review is currently not configured; use human technical review or a separately initiated reviewer when available, and label that evidence accurately. A review or CI fix returns through local verification and then the full applicable PR gate set. If the behavior accepted by the human changes materially, repeat Human Local Acceptance.

Branch protection and required-check settings are external GitHub controls and are not proved by workflow YAML. Until [`harness-setup.md`](harness-setup.md) is completed, manually account for every job in `.github/workflows/pr-check.yml` before merge. Do not equate a Draft PR, a green subset, or an aggregate summary with Ready or accepted.

## Knowledge capture

During planning, implementation, debugging, acceptance, and review, evaluate lessons that are durable, non-obvious, and reusable:

- `Observed`: direct code, test, configuration, runtime evidence, or an explicit authorized decision establishes the claim. Cite the owner and update the smallest durable source in the current branch.
- `Inferred`: evidence suggests a claim but does not establish intent. Record confidence and keep it non-normative until a maintainer confirms it.
- `Unknown`: a consequential question remains unanswered. Record its impact, evidence checked, and the person or source that can resolve it.

Route product rules to maintained product documentation and acceptance tests, architecture constraints to architecture guidance or a decision record, development rules to `AGENTS.md` or focused development docs, verification rules to this guide or tests, and operational knowledge to a runbook. Add deterministic enforcement only when it is cheap, cross-platform, and supported by authoritative intent. Review comments, resolved threads, or code alone do not prove business intent or knowledge adoption.

Automatic post-merge knowledge audit is not configured. Continuous capture in the active change is the required fallback. Late knowledge must use a separate human-reviewed PR; automation must never write directly to `main`.

## Release boundary

`pnpm release` edits package versions and `CHANGELOG.md`, builds, commits, tags, and pushes. Run it only after explicit release authorization. Tag pushes trigger `.github/workflows/release.yml`, which builds native artifacts, reruns deterministic gates, packages, publishes to npm, and creates a GitHub Release. The repository does not define preview/staging deployment or an operated service, and it has no documented package rollback procedure; release status and recovery remain maintainer-owned.

## Task evidence vocabulary

Capability status below describes whether a path is operational. Every task separately records each relevant execution outcome as `PASSED`, `FAILED`, `NOT EXECUTED`, or `NOT APPLICABLE`. `NOT EXECUTED` must include the capability status, reason, consequence, fallback or human action, and next trigger. Human Plan Review, Human Local Acceptance, merge, and release decisions are decisions, not automated check results.

## Harness Capability Report

Update an affected row when its command, host, runner, external setting, prerequisite, or representative verification changes. Repository files alone never upgrade an external capability to `READY`.

| Capability                                          | Status           | Current scope and evidence                                                                                                                                                               | Gap, fallback, and reevaluation trigger                                                                                                                                                                             |
| --------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Orientation and context delivery                    | `PARTIAL`        | Root `AGENTS.md` provides the package map, invariants, commands, safety notes, and links here; X-Code's documented knowledge chain consumes it.                                          | Loading and enforcement by other agent hosts are unverified. Fall back to explicitly opening `AGENTS.md`; reevaluate when a supported host or instruction path changes.                                             |
| Planning and Human Plan Review                      | `PARTIAL`        | This guide and the PR template define the full/fast paths and a decision surface in agent chat, an Issue, or a Draft PR.                                                                 | No repository control enforces a human response. Keep consequential work blocked until a named maintainer records a decision; reevaluate after a representative reviewed plan.                                      |
| Local Fast Verification                             | `READY`          | Root scripts provide focused tests, typecheck, non-mutating lint/format checks, and build; `pnpm run ci` is the broad local gate.                                                        | Scope selection remains task-specific. Reevaluate when package scripts, Node/pnpm requirements, or package boundaries change.                                                                                       |
| Unit tests                                          | `READY`          | Vitest's `unit` project covers core and CLI tests and is included by `pnpm test` and PR CI.                                                                                              | A passing run proves only exercised behavior. Reevaluate when Vitest projects or test inclusion patterns change.                                                                                                    |
| Integration, Package, Fault, and PTY tests          | `READY`          | Vitest defines dedicated `faults`, `package`, and `pty` projects; `pnpm test` includes them and CI runs them on all three supported OS families.                                         | Platform runner activation is accounted for separately under PR CI. Reevaluate when fixtures, native helpers, or project definitions change.                                                                        |
| Targeted Runtime Verification (credential-free CLI) | `READY`          | The built CLI supports safe `--version`/`--help` invocation, with fake-provider, package, and PTY fixtures for focused behavior.                                                         | Live-provider semantics are excluded. Use the next row when acceptance depends on an external model or search provider; reevaluate when CLI entrypoints change.                                                     |
| Targeted Runtime Verification (live model/provider) | `SETUP REQUIRED` | The real-LLM runner supports `--filter`, model selection, isolated scenario directories, and structured session evidence.                                                                | A human must approve provider, intended secret, data boundary, and cost; the child inherits the launching environment. Use credential-free fixtures or manual acceptance meanwhile; follow `harness-setup.md`.      |
| Human Local Acceptance                              | `PARTIAL`        | This guide and PR template name the requesting maintainer or delegate as decision owner and provide conversation, Issue, or PR recording surfaces.                                       | Availability and an actual decision cannot be automated. Keep the PR Draft until acceptance or an established policy is recorded; reevaluate after the repository adopts a stronger ownership rule.                 |
| Draft/Ready PR handling                             | `PARTIAL`        | The GitHub remote, PR-triggered workflow, and repository PR template provide a usable handoff path.                                                                                      | Branch rules and required-review settings are external and unverified. Manually enforce Ready criteria; follow `harness-setup.md` and reevaluate after a test PR.                                                   |
| Independent AI code review                          | `NOT CONFIGURED` | No repository workflow selects a reviewer runner, model, trigger, permissions, or failure behavior.                                                                                      | Use human technical review or a clearly separate manual reviewer. Reevaluate only after maintainers choose and verify an integration and data/cost boundary.                                                        |
| MR/PR CI                                            | `PARTIAL`        | `.github/workflows/pr-check.yml` defines lint/format, typecheck, cross-platform tests, native Windows, package, and commit-message jobs; the public Actions history shows PR Check runs. | Current branch-required checks and fork behavior are unverified. Account for every job manually and complete `harness-setup.md`; reevaluate after a representative PR from both a branch and, if supported, a fork. |
| Full E2E and placement policy                       | `SETUP REQUIRED` | `pnpm test:e2e` provides a real-LLM suite with targeted filters, resumable state, isolation, and documented cost; it is absent from PR CI.                                               | Maintainers must choose credentials, budget, owner, trigger/cadence, tested revision, blocking boundary, and failure route. Until then use the explicit Draft-PR fallback above.                                    |
| Continuous Knowledge Capture                        | `PARTIAL`        | This guide defines provenance, semantic owners, adoption evidence, and capture in the current change.                                                                                    | It is a human/agent review discipline, not a repository-enforced gate. PR reviewers must reject unsupported promotion; reevaluate when a recurring deterministic gap justifies a check.                             |
| Automatic Post-Merge Knowledge Audit                | `NOT CONFIGURED` | No merge trigger, trusted collector, headless agent/model integration, scoped permission, cost boundary, failure route, or knowledge-PR path exists.                                     | Continuous capture is the fallback. Reevaluate only after maintainers select the complete external path; never add direct-to-`main` writes.                                                                         |
| Architecture enforcement                            | `PARTIAL`        | `AGENTS.md` documents `cli -> core`, zero UI dependencies in core, public export snapshots, prompt-cache invariants, and cross-platform rules; type/tests enforce useful subsets.        | No single dependency rule mechanically enforces every architectural statement. Use review plus focused tests; reevaluate after a demonstrated drift failure.                                                        |
| Preview/staging acceptance                          | `NOT APPLICABLE` | The repository builds a local CLI/npm package and contains no preview or staging environment.                                                                                            | Reevaluate if a hosted runtime or environment-dependent release path is added.                                                                                                                                      |
| Operated-service observability                      | `NOT APPLICABLE` | No operated service is present; local debug logs and CI/release results are the applicable signals.                                                                                      | Reevaluate if the project begins operating a service.                                                                                                                                                               |
| Release and package observation                     | `PARTIAL`        | A tag-triggered GitHub workflow builds, verifies, publishes with provenance, and creates a GitHub Release; public history shows Release runs.                                            | External trusted-publishing settings, current permissions, and rollback are not safely verified here. Only a release-authorized maintainer may proceed; reevaluate after a release drill or rollback guide.         |
