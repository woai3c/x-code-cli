# e2e Test Suite

End-to-end tests that drive the real `xc -p` binary against a real LLM.
Different from the unit tests under `packages/*/tests/` (which mock everything),
these run a full agent loop and assert on what tools got called and what
artifacts ended up on disk.

## Quick start

```bash
# 1. Make sure the CLI is built
pnpm build

# 2. Set at least one API key in .env (or your shell env)
echo 'DEEPSEEK_API_KEY=sk-...' >> .env

# 3. Run
pnpm test:e2e
```

The runner detects which `*_API_KEY` you have set, lists the matching models,
and asks you to pick one. Default is `deepseek:deepseek-v4-flash` (cheap, fast).

## Flags

```text
pnpm test:e2e                      # interactive (pick model + resume/all)
pnpm test:e2e --all                # all scenarios, no prompts
pnpm test:e2e --resume             # only failed/skipped from last run
pnpm test:e2e --filter shell       # substring match against scenario id
pnpm test:e2e --model sonnet       # skip model picker (alias or full id)
pnpm test:e2e --list               # show scenario list + last status
pnpm test:e2e --keep-tmp           # keep tmpdir even on pass
pnpm test:e2e --print-jsonl        # print session jsonl path after each run
pnpm test:e2e --max-turns 8        # cap agent loop turns
```

## Cost

`deepseek-v4-flash` runs the whole suite (23 scenarios, ~50-100K tokens each)
for roughly **$0.10–0.18 per full run**. Each scenario takes 5–30 seconds.
Full suite: 4–8 minutes typically.

If you only want to verify changes near a specific area, use `--filter` and
spend much less.

## Resume from failure

The runner writes per-scenario results to `.state/last-run.json` immediately
after each scenario, so:

- `Ctrl+C` mid-run is safe — the already-completed scenarios are recorded.
- After fixing code, `pnpm test:e2e --resume` only re-runs the scenarios that
  failed (or were skipped because of missing keys) last time.
- Each failed scenario also stashes its session jsonl into
  `.state/failed-<id>.jsonl` so you can inspect what the model actually did
  even after the tmpdir is gone.

## Adding scenarios

Drop a `XX-name.ts` file into `scenarios/`. Use this template:

```ts
import type { Scenario } from '../framework/types.js'

const scenario: Scenario = {
  id: '16-my-thing',
  name: 'short description',
  // optional gate: only run if certain keys are present
  // requires: (env) => Boolean(env.TAVILY_API_KEY),
  // requiresReason: 'set TAVILY_API_KEY to enable',
  async run(ctx) {
    await ctx.writeFile('foo.txt', 'hello')
    const r = await ctx.runCli('Read foo.txt and echo its content', {
      args: ['--trust', '--max-turns', '6'],
    })
    ctx.expect.exitCode(r, 0)
    ctx.expect.toolCalled(r, 'readFile', { filePath: /foo\.txt$/ })
    ctx.expect.assistantMentions(r, 'hello')
  },
}

export default scenario
```

### `ctx` API

| Method                        | What it does                                                     |
| ----------------------------- | ---------------------------------------------------------------- |
| `ctx.tmpDir`                  | Absolute path to this scenario's temp directory. CLI runs there. |
| `ctx.modelId`                 | Resolved model id (e.g. `deepseek:deepseek-v4-flash`).           |
| `ctx.writeFile(rel, content)` | Write a file inside tmpDir.                                      |
| `ctx.readFile(rel)`           | Read a file.                                                     |
| `ctx.fileExists(rel)`         | Returns `Promise<boolean>`.                                      |
| `ctx.mkdir(rel)`              | Create a directory (recursive).                                  |
| `ctx.runCli(prompt, opts?)`   | Spawn `xc -p <prompt>` in tmpDir, return `RunResult`.            |

### `RunResult` shape

```ts
{
  assistantText: string             // model's final answer (from jsonl)
  toolCalls: ToolCall[]             // every tool-call event + matched result
  stdout: string; stderr: string
  exitCode: number
  durationMs: number
  sessionJsonlPath: string          // path to the jsonl, useful for debugging
  tokenUsage?: { input, output, cacheRead, cacheWrite }
}
```

### `ctx.expect` helpers

| Helper                               | What it asserts                                                      |
| ------------------------------------ | -------------------------------------------------------------------- |
| `toolCalled(r, name, inputMatcher?)` | A tool of given name was called (optionally matching input partial). |
| `toolNotCalled(r, name)`             | The tool was NOT called this run.                                    |
| `assistantMentions(r, needle)`       | Final assistant text contains the substring/regex.                   |
| `exitCode(r, code)`                  | Process exited with this code.                                       |
| `fileExists(rel)`                    | File exists at tmpDir-relative path.                                 |
| `fileContent(rel, matcher)`          | File content contains substring/regex.                               |
| `noToolErrors(r)`                    | None of the tool-results was marked `isError: true`.                 |
| `truthy(cond, msg)`                  | Generic "must be truthy" with custom message.                        |

Input matchers accept literal values, `RegExp`, predicates, and nested partials.

## Why we parse the session jsonl, not stdout

Print mode writes raw model text to stdout — no structured markers, no tool
boundaries. After the CLI exits we read the freshest jsonl under
`<tmpDir>/.x-code/sessions/`, which encodes every assistant tool-call and
tool-result as structured `{ t: 'msg', message: {...} }` entries. This survives
UI changes and is much easier to assert against.

If the jsonl is missing (e.g. CLI crashed before saveSession), we fall back to
stdout for `assistantText` so you still get something.

## Tips for writing reliable scenarios

1. **Assert behavior, not text**. ✅ `toolCalled('writeFile', { filePath: /foo/ })` / ✅ `fileExists('foo.txt')` — ❌ `expect(text).toBe('Created foo.')`
2. **Loose regex on assistant text**. The model phrases things differently each run; `/pnpm/i` not `'pnpm@9.0.0'`.
3. **Keep tmpDir small**. Many files = bigger context, slower runs, more $.
4. **Use `--max-turns` to cap runaway loops** for cheap models that misfire.
5. **Set `requires:` for optional scenarios** (web search needs Tavily/Brave key, etc.) so the suite doesn't fail when the key is absent.
