# Knowledge Base and Long-term Memory

X-Code CLI combines hand-maintained project knowledge with global long-term memory. Project rules live in the stable system prompt, while detailed memories are retrieved only when relevant instead of filling every request with the entire history.

中文版：[knowledge.md](./knowledge.md)

## Loading order

Knowledge is merged in this order at startup. Later project files have higher precedence:

```text
1. ~/.x-code/AGENTS.md                  # hand-written user preferences
2. ~/.x-code/memory/MEMORY.md           # derived global-memory Core profile
3. <repo>/AGENTS.md chain               # cwd to git root, root → leaf
4. <repo-root>/AGENTS.local.md          # private project preferences, usually gitignored
```

At each manual layer, `AGENTS.md` is preferred and `CLAUDE.md` is used as a read-only compatibility fallback. `/init` only creates or updates `AGENTS.md`.

On Windows, `~/.x-code` maps to `%USERPROFILE%\.x-code`. Set `X_CODE_HOME` to override the user directory, which is useful for isolated testing.

## Hand-written knowledge

### `~/.x-code/AGENTS.md`

Use this for stable rules that apply across repositories, such as language preferences, commit conventions, and standard tools. It enters every system prompt, so keep it concise.

### `<repo>/AGENTS.md`

Use this for shared architecture, commands, and constraints. In a monorepo, X-Code loads the full chain from the repository root to the current directory, allowing leaf files to override root rules.

### `<repo-root>/AGENTS.local.md`

Use this for private, machine-specific project preferences that should not be committed.

## Memory v2

Memory v2 is a user-level memory system shared across repositories. Every repository uses the same global namespace:

```text
~/.x-code/memory/
  MEMORY.md                 # deterministically derived; not the source of truth
  topics/*.md               # complete memory text and sole source of truth
  .state/
    schema.json
    jobs/{pending,running,failed}/
    transactions/
    changes/
    locks/
    recent-runs.jsonl
```

Repository relationships are stored in each topic's `applies_to` metadata and influence ranking. X-Code no longer creates project-level auto-memory files.

### When memory is written

After a complete root-agent clean stop, the CLI atomically writes only that turn's projection to a durable job. The main answer does not wait for the memory model; a background worker extracts and commits durable facts afterward.

Intermediate tool rounds, sub-agents, aborts, errors, content filters, and terminal length truncation do not create memory jobs.

The extractor focuses on:

- User identity, expertise, long-term goals, language, and collaboration preferences.
- Products the user maintains, repository relationships, high-level stacks, and non-obvious architecture reasons.
- Explicit corrections and confirmed ways of working.
- Workflows, project decisions, and references that remain valuable across sessions.

Routine diffs, temporary errors, dependency inventories, one-off tasks, secrets, and model inference are excluded. Secret redaction runs before both job persistence and topic commits.

### Conflicts and deletion

Each fact uses a stable `factId` representing a subject and predicate. When the user supplies a newer, more accurate value, the new value and every old location are handled in one transaction. The old value is physically removed rather than kept as a retrievable archive.

A delayed old job cannot overwrite a fact with a newer `observedAt`. Explicit user statements, successful tool evidence, and future plans follow fact-specific arbitration rules. Ambiguous conflicts are rejected rather than duplicated.

To delete memory, tell the agent explicitly, for example:

```text
Forget my previous deployment-platform preference.
```

Explicit forget physically deletes the target facts. Session-transcript privacy deletion is a separate feature.

### How recall works

A new session keeps only a bounded Core profile resident. For each user request:

1. Local exact, alias, path, identifier, and BM25F retrieval runs without model tokens.
2. Strong matches load only relevant sections and inject them as low-authority historical attachments into a request copy.
3. Only ambiguous questions that genuinely depend on history use the semantic selector. It sees a compact topic manifest, never the full topic bodies.
4. New paths, packages, error codes, or identifiers found in successful tool results can trigger one late-bound local recall.

This release does not use embeddings, a vector database, or SQLite. Markdown is the only source of memory content.

## `/memory` commands

```text
/memory
/memory status
/memory search <query>
/memory search --semantic <query>
/memory explain
/memory reload
```

- `/memory`: list topic type, summary, fact count, and pinned state.
- `/memory status`: show schema, generation, queue, worker, recent run, and invalid topics.
- `/memory search`: locally retrieve up to five relevant sections.
- `/memory search --semantic`: explicitly ask the AI selector to choose relevant topics.
- `/memory explain`: show routes, scores, selection, and token packing for the latest recall.
- `/memory reload`: load manual edits and rebuild `MEMORY.md` and the index.

`memorySearch` is also a read-only root-agent tool. It cannot enumerate all memory or expand beyond candidates related to the current request. Sub-agents do not receive this tool and never create memory jobs.

## Manual editing

The complete source text lives in `~/.x-code/memory/topics/*.md`. You may edit it directly, but a running CLI does not use `fs.watch`: run `/memory reload` or restart after editing.

Important details:

- Do not edit `MEMORY.md`; it is derived and will be overwritten.
- Hand-written text without an `x-memory` marker remains searchable and is never deleted by the automatic writer.
- Broken frontmatter, fact markers, duplicate fact IDs, or related links isolate the entire topic from the active index and surface an error in `/memory status`.
- Automatic transactions write only topics actually affected by an operation; unrelated hand-formatted Markdown files stay byte-identical.

## Legacy `auto.md`

Memory v2 does not migrate the old system:

- `~/.x-code/memory/auto.md` and `<repo>/.x-code/memory/auto.md` are never read.
- They are not validated, moved, renamed, or deleted.
- Their presence does not cause an error or affect v2 initialization and writes.

Users may back up or remove those files themselves if they no longer need them. The CLI never cleans them up proactively.

## Configuration

`~/.x-code/config.json` supports:

```json
{
  "memory": {
    "enabled": true,
    "model": "inherit",
    "maxInputTokens": 12000,
    "maxOutputTokens": 1500,
    "maxOperationsPerTurn": 8,
    "drainTimeoutMs": 5000,
    "retryMaxAttempts": 8,
    "recall": {
      "maxTopicsPerTurn": 5,
      "maxTokensPerTopic": 1500,
      "maxTokensPerTurn": 4000,
      "maxTokensPerCompactionWindow": 15000,
      "semanticSelector": "auto",
      "selectorModel": "inherit",
      "lateBoundRecall": true
    }
  }
}
```

`inherit` uses the active main model. Provider credentials remain environment-only and are never persisted in a job.

## Troubleshooting

| Symptom                                | Fix                                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `/memory` is empty                     | Normal for a fresh store; complete a turn containing a durable fact, then inspect `/memory status`        |
| Pending jobs do not drain              | Check provider keys and the worker and Last run fields in `/memory status`                                |
| Failed count increases                 | Inspect the status error category; enable `DEBUG_STDOUT=1` and read `~/.x-code/logs/debug.log`            |
| Manual edits do not appear             | Run `/memory reload` or restart; there is no watcher                                                      |
| A topic disappears                     | Check the Invalid list for broken frontmatter, fact IDs, or related links                                 |
| Recall is inaccurate                   | Use `/memory explain` to inspect exact/BM25F/selector routing, then try a specific `/memory search` query |
| Need to verify cross-repository recall | Use the same `X_CODE_HOME` in two repositories, save a fact in one, and ask for it in the other           |

Use `AGENTS.md` for explicit rules that must always apply. Use Memory v2 for user-profile and long-term facts maintained from complete conversations and recalled on demand.
