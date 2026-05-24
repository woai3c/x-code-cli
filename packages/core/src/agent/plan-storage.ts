// @x-code-cli/core — Plan-mode file storage
//
// Plans live in `.x-code/plans/<slug>-<YYYYMMDD-HHMMSS>.md` inside the
// user's project (NOT in the user-scope `~/.x-code/`). This mirrors how
// `.x-code/sessions/` and `.x-code/memory/` are scoped: per-project,
// gitignored, never shared across repos. The slug-then-timestamp shape
// matches the legacy filenames already living under `.x-code/plans/`
// (e.g. `vue-3-vite-typescript-snake-game-20260420-102410.md`) — both
// human-skimmable in `ls` AND sortable by recency.
//
// Claude Code stores plans globally under `~/.claude/plans/{slug}.md`
// with random word-pair slugs (`brilliant-crystal.md`). We chose
// project-local + topic-derived slug on the user's request — easier to
// find later, and the plan stays with the repo it was written for.
import fs from 'node:fs/promises'
import path from 'node:path'

import { generateText } from 'ai'
import type { LanguageModel } from 'ai'

import { getThinkingProviderOptions } from '../providers/thinking.js'
import { XCODE_DIR, debugLog } from '../utils.js'

const PLANS_SUBDIR = 'plans'
const SLUG_MAX_LEN = 40

/** Convert an arbitrary task description into a filesystem-safe,
 *  lower-case, hyphen-separated slug. Drops anything outside
 *  `[a-z0-9 -]` (so CJK / emoji / punctuation collapse to nothing —
 *  CJK-only tasks produce an empty slug, which is intentional and
 *  caught by callers' timestamp-only fallback). Length capped at
 *  SLUG_MAX_LEN cells so `ls` columns stay readable. Exported so
 *  session-usage filenames can mirror the same shape as plan files. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LEN)
    .replace(/-+$/g, '')
}

/** Format a Date as `YYYYMMDD-HHMMSS`. Local time, no zone suffix —
 *  matches the legacy plan-file convention which is what the user is
 *  used to scanning visually. */
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

function plansDir(): string {
  return path.join(process.cwd(), XCODE_DIR, PLANS_SUBDIR)
}

/** Build a fresh plan-file path from a task description (typically the
 *  user's most recent message). Pure function — no I/O — so callers
 *  can stash the path on LoopState before the file actually exists.
 *  Format: `<slug>-<timestamp>.md` (slug-only when timestamp could
 *  conflict, timestamp-only when the task text produces an empty
 *  slug). Pass `opts.slug` when the caller already has a precomputed
 *  slug (e.g. agentLoop's session-wide LLM-generated `taskSlug`) to
 *  skip the local slugify pass — important for non-ASCII task text
 *  where slugify would return empty. */
export function makePlanFilePath(taskText: string, opts?: { slug?: string; now?: Date }): string {
  const slug = opts?.slug ?? slugify(taskText)
  const ts = formatTimestamp(opts?.now ?? new Date())
  const name = slug ? `${slug}-${ts}` : ts
  return path.join(plansDir(), `${name}.md`)
}

/** Min length of a locally-slugified result for the fast path to
 *  apply. Below this we assume the user's first message had little
 *  ASCII content (typical CJK-only message: 0; "fix bug": ≥6) and ask
 *  the model for an English summary instead of producing an unhelpful
 *  one-letter filename. */
const ASCII_FAST_PATH_MIN_LEN = 6

/** Cap on raw user text sent to the slug model. The summary only
 *  needs the gist; a 5000-character paste would just waste input
 *  tokens. */
const TASK_TEXT_TRUNCATE = 500

/** Hard cap on output tokens for the slug call. Sized for "2-4 short
 *  English words" (~10 visible tokens) PLUS a comfortable margin for
 *  reasoning models that emit hidden thinking tokens before any
 *  visible text. We disable thinking explicitly below where the
 *  provider supports it, but DeepSeek's `disabled` and Anthropic's
 *  `disabled` aren't always honored on every model id, so the budget
 *  has to survive a small amount of forced reasoning too. */
const SLUG_MAX_OUTPUT_TOKENS = 256

/** Derive a human-skimmable filename slug for the session.
 *
 *  Fast path: if `slugify(taskText)` already produces ≥6 chars (i.e.
 *  the user typed something English-y), return it directly — zero
 *  network, zero tokens. Covers the entire English-prompt user base.
 *
 *  Slow path: for CJK-only / emoji-heavy / very short first messages
 *  where slugify returns empty or near-empty, make ONE isolated
 *  generateText call asking for 2-4 lowercase English words. No
 *  message history, no tools, no system context — just the user's
 *  raw text (truncated) and a strict instruction. Disables thinking
 *  on providers that support it so the small token budget isn't
 *  spent on hidden reasoning before any visible text appears.
 *
 *  Returns '' on any failure (including abort). Callers treat empty
 *  as "fall back to timestamp-only naming", matching pre-existing
 *  behavior so adding this helper can't regress anyone. */
export async function generateTaskSlug(
  taskText: string,
  model: LanguageModel,
  modelId: string,
  signal?: AbortSignal,
): Promise<string> {
  const localSlug = slugify(taskText)
  if (localSlug.length >= ASCII_FAST_PATH_MIN_LEN) {
    debugLog('slug.fast-path', `len=${localSlug.length} slug="${localSlug}"`)
    return localSlug
  }

  debugLog('slug.llm-start', `taskTextLen=${taskText.length} modelId=${modelId}`)
  try {
    const { text, usage, finishReason } = await generateText({
      model,
      abortSignal: signal,
      providerOptions: getThinkingProviderOptions(modelId, false) as Parameters<
        typeof generateText
      >[0]['providerOptions'],
      system:
        'You convert user task descriptions into short English filename slugs. ' +
        'Reply with ONLY 2 to 4 lowercase English words separated by spaces. ' +
        'No punctuation, no quotes, no explanation, no prefixes like "slug:". ' +
        'If the input is non-English, translate the gist into English first.',
      prompt: taskText.slice(0, TASK_TEXT_TRUNCATE),
      maxOutputTokens: SLUG_MAX_OUTPUT_TOKENS,
    })
    const slug = slugify(text)
    debugLog(
      'slug.llm-result',
      `finishReason=${finishReason} rawText="${(text ?? '').slice(0, 80)}" slug="${slug}" tokens=${usage?.outputTokens ?? '?'}`,
    )
    return slug
  } catch (err) {
    debugLog('slug.llm-error', err instanceof Error ? err.message : String(err))
    return ''
  }
}

/** Make sure the plan directory exists. Recursive mkdir so we don't have
 *  to also ensure `.x-code/` separately — first plan written in a fresh
 *  project gets the parent created automatically. */
export async function ensurePlanDir(): Promise<void> {
  await fs.mkdir(plansDir(), { recursive: true })
}

/** Read the plan body at `planPath`. Empty string when the file doesn't
 *  exist — exitPlanMode calls this to grab whatever the model has
 *  written so far, and "no plan written yet" is a valid (if unhelpful)
 *  state. */
export async function readPlan(planPath: string): Promise<string> {
  try {
    return await fs.readFile(planPath, 'utf-8')
  } catch {
    return ''
  }
}

/** Persist the plan body to `planPath`. Used by exitPlanMode when the
 *  model passes a `plan` override so the on-disk record matches what
 *  the user is approving. Returns the path it wrote to (always equal
 *  to the input). */
export async function writePlan(planPath: string, body: string): Promise<string> {
  await ensurePlanDir()
  await fs.writeFile(planPath, body, 'utf-8')
  return planPath
}
