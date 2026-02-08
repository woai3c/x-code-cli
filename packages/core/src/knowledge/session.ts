// @x-code/core — Session memory (structured JSON summaries for cross-session continuation)

import fs from 'node:fs/promises'
import path from 'node:path'

import { generateText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'

import type { SessionSummary } from '../types/index.js'

const SESSIONS_DIR = '.x-code/sessions'

function getSessionsDir(): string {
  return path.join(process.cwd(), SESSIONS_DIR)
}

function getLatestPath(): string {
  return path.join(getSessionsDir(), 'latest.json')
}

/** Load the most recent session summary */
export async function loadLatestSession(): Promise<SessionSummary | null> {
  try {
    const raw = await fs.readFile(getLatestPath(), 'utf-8')
    return JSON.parse(raw) as SessionSummary
  } catch {
    return null
  }
}

/** Save a session summary */
export async function saveSessionSummary(summary: SessionSummary): Promise<void> {
  const dir = getSessionsDir()
  await fs.mkdir(dir, { recursive: true })

  await fs.writeFile(getLatestPath(), JSON.stringify(summary, null, 2), 'utf-8')

  const archivePath = path.join(dir, `${summary.id}.json`)
  await fs.writeFile(archivePath, JSON.stringify(summary, null, 2), 'utf-8')
}

/** Generate a session summary from messages using the model */
export async function generateSessionSummary(
  messages: ModelMessage[],
  model: LanguageModel,
  sessionId: string,
  startedAt: string,
  filesModified: string[],
): Promise<SessionSummary> {
  const { text } = await generateText({
    model,
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
      ...messages.slice(-20),
    ],
  })

  try {
    const parsed = JSON.parse(text)
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

/** Format session summary for system prompt injection */
export function formatSessionForPrompt(session: SessionSummary): string {
  const lines = [
    `### Previous Session`,
    `Title: ${session.title}`,
    `Status: ${session.status}`,
    `Summary: ${session.summary}`,
  ]
  if (session.keyResults.length > 0) {
    lines.push('Key results:')
    for (const r of session.keyResults) lines.push(`- ${r}`)
  }
  if (session.pendingWork.length > 0) {
    lines.push('Pending work:')
    for (const w of session.pendingWork) lines.push(`- ${w}`)
  }
  if (session.decisions.length > 0) {
    lines.push('Decisions:')
    for (const d of session.decisions) lines.push(`- ${d}`)
  }
  return lines.join('\n')
}
