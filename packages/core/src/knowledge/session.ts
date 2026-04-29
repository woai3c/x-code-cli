// @x-code-cli/core — LLM-generated session summaries (used by the agent
// loop's deep compaction path).
//
// What used to live here: `saveSessionSummary` + `loadLatestSession`,
// which wrote `<sessionId>.json` and `latest.json` into
// `.x-code/sessions/`. Both are gone — the full session transcript now
// lives in a single `.jsonl` per session (see `agent/session-store.ts`),
// and compaction summaries are embedded as `compact-boundary` meta lines
// inside that same jsonl. One file per session, no out-of-band siblings.
//
// What remains: `generateSessionSummary` — a small isolated `generateText`
// call that the loop invokes when context overflows and needs to be
// compressed into a paragraph. The result is fed to `markBoundaryAndReflush`
// (in session-store) and also wrapped into a "[Previous conversation
// summary]" user message that replaces the discarded prefix in
// `state.messages`.
import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import type { SessionSummary } from '../types/index.js'

/** Number of recent messages to include when generating session summaries */
const SESSION_SUMMARY_MESSAGE_COUNT = 20

/** Generate a session summary from messages using the model. Returns the
 *  full structured `SessionSummary` (title + status + key results +
 *  pendingWork + decisions) — callers typically want the `summary` field
 *  for context replacement and the rest for picker / display purposes. */
export async function generateSessionSummary(
  messages: ModelMessage[],
  model: LanguageModel,
  sessionId: string,
  startedAt: string,
  filesModified: string[],
  signal?: AbortSignal,
): Promise<SessionSummary> {
  const { text } = await generateText({
    model,
    abortSignal: signal,
    messages: [
      {
        role: 'system',
        content: `Summarize this conversation as a structured JSON object with these fields:
- title: short descriptive title (string)
- summary: 2-3 sentence overview (string)
- keyResults: what was accomplished (string[])
- pendingWork: what remains to be done (string[])
- decisions: important decisions made (string[])
- status: "completed" | "in_progress" | "abandoned"

Return ONLY valid JSON, no markdown fencing.`,
      },
      ...messages.slice(-SESSION_SUMMARY_MESSAGE_COUNT),
    ],
  })

  try {
    const parsed = JSON.parse(text) as Partial<SessionSummary>
    return {
      id: sessionId,
      startedAt,
      endedAt: new Date().toISOString(),
      filesModified,
      title: parsed.title ?? 'Untitled session',
      summary: parsed.summary ?? '',
      keyResults: parsed.keyResults ?? [],
      pendingWork: parsed.pendingWork ?? [],
      decisions: parsed.decisions ?? [],
      status: parsed.status ?? 'completed',
    }
  } catch {
    return {
      id: sessionId,
      startedAt,
      endedAt: new Date().toISOString(),
      title: 'Session',
      summary: text.slice(0, 200),
      keyResults: [],
      pendingWork: [],
      filesModified,
      decisions: [],
      status: 'completed',
    }
  }
}
