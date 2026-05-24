// @x-code-cli/core — Post-turn memory extractor (silent path).
//
// Runs as a fire-and-forget pass after each `finishReason === 'stop'` in
// agentLoop. Sees the recent transcript, decides what (if anything) is
// durable cross-session knowledge, and writes to AutoMemory directly.
//
// The main agent has NO memory-write tool exposed — `saveKnowledge` was
// removed from the tool registry. Memory writes happen exclusively
// through this extractor, matching Codex's "main agent is read-only for
// memory" philosophy. Any visible `● SaveKnowledge` row in the ChatInput
// frame would feel like the AI doing things behind the user's back right
// as they're about to type the next prompt.
//
// Implementation: one `generateText` round-trip with an `output` setting
// (the v6 replacement for the deprecated `generateObject`). No agentLoop,
// no turn budget, no tool filter, no sub-callbacks. The model returns a
// structured object; we iterate the `memories` array and call
// AutoMemory.add() for each.
import { Output, generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import { z } from 'zod'

import { getAutoMemory } from '../knowledge/auto-memory.js'
import type { KnowledgeFact, MemoryWriteNotice } from '../types/index.js'
import { debugLog } from '../utils.js'
import type { LoopState } from './loop-state.js'

/** Cap on how many of the most-recent main-loop messages we replay to
 *  the extractor. 12 is enough for a few full "user said X → assistant
 *  did Y → user reacted Z" turns without dragging in stale background. */
const MAX_TRANSCRIPT_MESSAGES = 12

/** Skip the extractor entirely if the transcript is too short — nothing
 *  durable in a single greeting + reply. */
const MIN_TRANSCRIPT_MESSAGES = 4

/** Bound the blast radius if the model gets imaginative. At most this
 *  many writes per pass even on pathological output. */
const MAX_MEMORIES_PER_PASS = 3

/** Serialize concurrent extractor calls. JS is single-threaded so this
 *  is just a re-entrancy guard, not a real lock — keeps two back-to-back
 *  stops from racing on the same transcript. */
let inflight: Promise<void> = Promise.resolve()

const MemoryItemSchema = z.object({
  category: z.enum(['user', 'feedback', 'project', 'reference']),
  scope: z.enum(['project', 'user']),
  key: z.string().min(1).describe('Short slug. Same key under same category overwrites the previous fact.'),
  fact: z.string().min(1).describe('The fact itself. Lead with the rule; for feedback include a one-line reason.'),
})

const MemorySchema = z.object({
  /** Empty array means "nothing to save" — the model's preferred no-op. */
  memories: z.array(MemoryItemSchema).max(MAX_MEMORIES_PER_PASS),
})

/** Render both AutoMemory scopes as a snapshot the extractor can scan
 *  before deciding whether to write. Without this the model has no idea
 *  what's already saved and routinely produces near-duplicates under
 *  fresh keys (`role` + `user-stack` + `user-profile` for the same
 *  person). The dedup-by-(category, key) check in `AutoMemory.add()`
 *  only catches exact key collisions, not semantic overlap, so the
 *  prevention has to happen in the extractor's prompt. */
function renderExistingMemory(): string {
  const user = getAutoMemory('user').getPromptContent().trim()
  const project = getAutoMemory('project').getPromptContent().trim()
  const sections: string[] = []
  sections.push(`## User (~/.x-code/memory/auto.md)\n${user || '(empty)'}`)
  sections.push(`## Project (.x-code/memory/auto.md)\n${project || '(empty)'}`)
  return sections.join('\n\n')
}

/** Render the transcript tail as plain text the extractor can read.
 *  Tool-calls and tool-results collapse to bracketed markers — the
 *  extractor only cares about user/assistant intent, not tool details. */
function renderTranscript(messages: ModelMessage[]): string {
  const tail = messages.slice(-MAX_TRANSCRIPT_MESSAGES)
  const lines: string[] = []
  for (const msg of tail) {
    const role = msg.role
    if (role === 'system') continue
    const content = msg.content
    if (typeof content === 'string') {
      lines.push(`### ${role}\n${content.trim()}`)
      continue
    }
    if (!Array.isArray(content)) continue
    const parts: string[] = []
    for (const part of content as Array<{
      type?: string
      text?: string
      toolName?: string
    }>) {
      if (part?.type === 'text' && typeof part.text === 'string') {
        parts.push(part.text.trim())
      } else if (part?.type === 'tool-call' && typeof part.toolName === 'string') {
        parts.push(`[tool-call: ${part.toolName}]`)
      } else if (part?.type === 'tool-result') {
        parts.push('[tool-result]')
      }
    }
    const body = parts.filter(Boolean).join('\n').trim()
    if (body) lines.push(`### ${role}\n${body}`)
  }
  return lines.join('\n\n')
}

const SYSTEM_PROMPT = `You are a post-turn memory extractor for a coding-assistant CLI.

The main agent has just finished replying to the user. Scan the recent transcript and decide whether anything in it is **durable cross-session knowledge** worth saving. Output a JSON object matching the provided schema: \`{ "memories": [...] }\`. **Empty array means save nothing — that is the default and often correct.**

# Hard rules

1. **Quality over quantity.** Output AT MOST 1-2 memories per pass; an empty array is fine.
2. **Never save the user's CURRENT TASK or REQUEST.** "User wanted me to refactor X" / "user asked me to debug Y" is transient and has zero value next session.
3. **Never save anything derivable from code or git history.** Tech stack, dependencies, file layout, commit author, when something changed — the agent can re-read these next session.
4. **Save EXACTLY what the user said. No inference, no generalization, no padding, no fabricated rules.**
   - If they said "Node.js engineer", save "Node.js engineer" — do NOT generalize to "frontend engineer" or specialize to "backend engineer".
   - If they said "reply in Chinese", save "User wants replies in Chinese" — do NOT add "user has limited English", "is from mainland China", or any implication.
   - Do NOT invent rules the user did not state ("keep variable names in English", "explain by analogy", "use simple words"). If they didn't say it, it isn't a fact.
   - When tempted to add motivation, audience, or implication, stop. Quote the user.
   - One stated fact = one short fact in the output. Do not pad a single sentence into a paragraph.
5. **Don't write near-duplicates. Reuse keys to update.** The user message includes an "Existing memory" snapshot of everything already saved.
   - If your candidate fact is already covered there — even under a different key, different category, or slightly different phrasing — RETURN EMPTY for it. The fact is already in the system prompt next session; writing it again under a fresh key just clutters memory.
   - If you want to REFINE an existing fact (more accurate, more complete), REUSE its exact \`(category, key)\` so \`AutoMemory.add()\` overwrites it in place. Different key = duplicate, not update.
   - Common pitfall: writing \`role\` AND \`user-stack\` AND \`user-profile\` for the same person. Pick whichever canonical key already exists in the snapshot and reuse it; if none exists, pick one and don't drift later.

# What to save (pick the matching category)

**user** — durable facts about who the human is, changing how you'd talk to them next session.
  Trigger: role, expertise, working environment, language preferences, long-term constraints.
  Example: User says "I've been writing Go for ten years but this is my first time touching the React side."
  → \`{ category: "user", scope: "user", key: "user-stack", fact: "Ten years of Go; first time touching React in this repo." }\`
  (Note: the fact is a direct paraphrase. Do NOT add "explain by analogy" or any other prescriptive action — that's inference, not what the user said.)

**feedback** — corrections OR validated approaches. Both count. Lead with the rule, include a one-line reason.
  Trigger A (correction): "no", "stop", "don't do X", "you got Y wrong because…".
    Example: "Stop using --no-verify on commits, last time we did that CI went red."
    → \`{ category: "feedback", scope: "project", key: "no-skip-hooks", fact: "Never use git --no-verify; previously bypassed pre-commit hook and broke CI." }\`
  Trigger B (validated approach): user accepts a non-obvious choice without pushback. Quieter than corrections — watch for them.
    Example: "yeah that's right, splitting would be churn" after assistant suggested bundling.
    → \`{ category: "feedback", scope: "project", key: "refactor-bundling", fact: "Bundle related refactors into one PR rather than splitting; user-validated as reducing churn." }\`

**project** — ongoing work, decisions, deadlines, or non-obvious project state. Convert relative dates to absolute.
  Example: "Mobile release branch cuts Thursday — non-critical merges blocked after that."
  → \`{ category: "project", scope: "project", key: "release-freeze", fact: "Mobile release freeze begins 2026-03-05. Flag non-critical merges past that date." }\`

**reference** — pointers to external systems (tickets, dashboards, docs).
  Example: "Pipeline bugs are tracked in Linear project INGEST."
  → \`{ category: "reference", scope: "project", key: "linear-pipeline", fact: "Pipeline bugs tracked in Linear project INGEST." }\`

# What NOT to save

- Current request, task, file edits, bug fix, or anything tied to "what we just did". → empty.
- The model's own opinion about the user. → empty.
- Vague impressions ("user prefers concise answers") with no concrete trigger sentence. → empty.
- Single-word reactions ("nice", "ok", "thanks") without context. → empty.
- **Inferences from the user's words.** If they say "Node.js engineer", do NOT save "frontend engineer" or "backend engineer" — both are guesses. Save what they literally wrote.
- **Demographic/skill assumptions** the user did NOT state (nationality, English level, seniority beyond what was claimed, team size). → empty.
- **Self-invented rules** dressed up as user preferences ("keep variable names English", "use markdown headings"). If the user did not say it this session, it is not a fact. → empty.

# Scope rule

- Project-specific facts (this repo / team / release): \`scope: "project"\`.
- Cross-project facts about the user themselves (stack expertise, OS, name): \`scope: "user"\`.

When in doubt, prefer empty array. The user can always type the durable fact again next session if it really matters.`

const USER_TEMPLATE = (transcript: string, existing: string) =>
  `# Existing memory (already saved — DO NOT duplicate, see Hard rule 5)

${existing}

---

# Recent main-loop transcript

${transcript}

---

Output a JSON object matching the schema. Empty \`memories\` array means save nothing — that is the default and often correct. Anything already present in the Existing memory snapshot above is by definition not new — return empty for it unless you are deliberately reusing its exact (category, key) to overwrite with a refined version.`

export interface RunMemoryExtractorArgs {
  parentState: LoopState
  parentModel: LanguageModel
  abortSignal?: AbortSignal
  /** Fired once per successful AutoMemory write so the UI can surface a
   *  "Remembered: …" line in scrollback. The extractor is fire-and-forget,
   *  so this may be invoked after the parent agentLoop has already
   *  returned — closures must remain valid. */
  onWrite?: (notice: MemoryWriteNotice) => void
}

/** Fire-and-forget memory extraction. Caller should `void runMemoryExtractor(...)`
 *  — awaiting it would block the user from typing the next prompt.
 *
 *  Writes go straight to AutoMemory at file level. There is no
 *  user-facing memory-write tool: the main agent has no way to write
 *  memory itself, so extraction is the sole write path. Silent matches
 *  Codex's "main agent is read-only for memory" convention. */
export async function runMemoryExtractor(args: RunMemoryExtractorArgs): Promise<void> {
  inflight = inflight.then(() => doExtract(args)).catch(() => undefined)
  return inflight
}

async function doExtract(args: RunMemoryExtractorArgs): Promise<void> {
  const { parentState, parentModel, abortSignal, onWrite } = args

  if (abortSignal?.aborted) return
  if (parentState.messages.length < MIN_TRANSCRIPT_MESSAGES) return

  const transcript = renderTranscript(parentState.messages)
  if (!transcript) return

  // Snapshot existing memory so the model can detect semantic overlap with
  // already-saved facts (the dedup in AutoMemory.add only catches exact
  // (category, key) collisions). Cost: a few hundred extra prompt tokens
  // per pass, paid once per turn — much cheaper than letting the file
  // grow unbounded with `role` + `user-profile` + `user-stack` triples.
  const existing = renderExistingMemory()

  debugLog('memory-extractor.start', `transcript-bytes=${transcript.length} existing-bytes=${existing.length}`)
  const startTime = Date.now()

  try {
    const { output: object } = await generateText({
      model: parentModel,
      system: SYSTEM_PROMPT,
      prompt: USER_TEMPLATE(transcript, existing),
      output: Output.object({ schema: MemorySchema }),
      abortSignal,
    })

    const today = new Date().toISOString().slice(0, 10)
    let written = 0
    for (const m of object.memories.slice(0, MAX_MEMORIES_PER_PASS)) {
      const fact: KnowledgeFact = {
        key: m.key,
        fact: m.fact,
        category: m.category,
        date: today,
      }
      try {
        getAutoMemory(m.scope).add(fact)
        written++
        debugLog('memory-extractor.write', `[${m.scope}/${m.category}] ${m.key}: ${m.fact.slice(0, 100)}`)
        // Fire the UI notification AFTER the add succeeds. Wrapped in its
        // own try/catch — a thrown UI callback shouldn't abort remaining
        // writes in this batch.
        if (onWrite) {
          try {
            onWrite({ scope: m.scope, category: m.category, key: m.key, fact: m.fact })
          } catch {
            // intentionally swallowed
          }
        }
      } catch (err) {
        // AutoMemory.add wraps the FS write in a queued save; failures
        // surface here only on validation throws, which shouldn't happen
        // since zod already validated the category enum.
        const msg = err instanceof Error ? err.message : String(err)
        debugLog('memory-extractor.write-fail', `${m.key}: ${msg}`)
      }
    }
    debugLog(
      'memory-extractor.done',
      `written=${written} skipped=${object.memories.length - written} duration=${Date.now() - startTime}ms`,
    )
  } catch (err) {
    if (abortSignal?.aborted) {
      debugLog('memory-extractor.aborted', 'parent abort')
      return
    }
    // Catches NoOutputGeneratedError, network errors, schema-mismatch
    // retries exhausted, etc. The user isn't waiting on this — debugLog
    // and move on.
    const msg = err instanceof Error ? err.message : String(err)
    debugLog('memory-extractor.fail', msg)
  }
}
