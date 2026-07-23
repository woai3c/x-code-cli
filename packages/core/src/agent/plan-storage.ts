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

import { XCODE_DIR } from '../utils.js'

const PLANS_SUBDIR = 'plans'
const SLUG_MAX_LEN = 40

/** Convert an arbitrary task description into a filesystem-safe,
 *  lower-case, hyphen-separated slug. Drops anything outside
 *  `[a-z0-9 -]` (so CJK / emoji / punctuation collapse to nothing —
 *  CJK-only tasks produce an empty slug, which is intentional and
 *  caught by callers' timestamp-only fallback). Length capped at
 *  SLUG_MAX_LEN cells so `ls` columns stay readable. */
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
 *  slug (e.g. agentLoop's session-wide `taskSlug`) to
 *  skip the local slugify pass — important for non-ASCII task text
 *  where slugify would return empty. */
export function makePlanFilePath(taskText: string, opts?: { slug?: string; now?: Date }): string {
  const slug = opts?.slug ?? slugify(taskText)
  const ts = formatTimestamp(opts?.now ?? new Date())
  const name = slug ? `${slug}-${ts}` : ts
  return path.join(plansDir(), `${name}.md`)
}

/** Derive a human-skimmable filename slug for the session.
 *
 *  This must stay local and synchronous: session naming is metadata and
 *  must never delay the user's first model request. CJK-only / emoji-only
 *  input returns '', which callers map to timestamp-only filenames. */
export function generateTaskSlug(taskText: string): string {
  return slugify(taskText)
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
